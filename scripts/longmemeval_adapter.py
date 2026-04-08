#!/usr/bin/env python3
"""
LongMemEval <-> vault-mind / llm-wiki retrieval adapter.

Wires LongMemEval's benchmark loop (see
src/retrieval/run_retrieval.py in xiaowu0162/LongMemEval) onto the
vault-bridge WebSocket server (or the python fs fallback in vault_bridge.py).

Data flow:

  LongMemEval JSON ──ingest──> temp vault (.md per turn)
                                    │
                                    │ vault.search(query) / searchByFrontmatter
                                    ▼
                                vault-mind
                                    │ ranked turn_ids
                                    ▼
                          LongMemEval retrieval_log (jsonl)
                                    │
                                    │ print_retrieval_metrics.py
                                    ▼
                         recall_all@5 / recall_all@10 / ndcg_any@k

IMPORTANT REALITY CHECK:

  vault.search in vault-mind is **regex/literal substring fulltext**, not
  vector search. See D:/projects/obsidian-vault-bridge/src/bridge.ts:101
  (BridgeApp.search) -- it compiles the query into a RegExp, iterates the
  vault's markdown files, and returns per-line matches. There are no
  embeddings and no semantic ranking.

  This means the BASELINE run will answer the open question:
    "What does a pure regex fulltext retriever score on LongMemEval
     without ANY vector/embedding step?"
  The answer is almost certainly poor on preference / multi-session /
  temporal-reasoning questions (where the query wording and the evidence
  wording differ lexically). Expect R@5 in the 20-40 range, not 60-90.

  The +34% wing/room metadata filter boost that mempalace reported
  (E:/knowledge/04-Research/mempalace-research-2026-04-08.md) was measured
  on top of a vector retriever. Re-measuring it on a fulltext-only base
  may not show the same lift. Capture the number anyway -- the point of
  this exercise is to replace guesses with actual numbers.

RANKING MODEL:

  For each LongMemEval question, we treat its haystack (only the turns that
  share `question_id` in frontmatter) as the corpus. vault.search is called
  on the question text across that namespace via the `glob` filter so it
  only touches `{vault}/conv_{qid}/**`.

  Score per turn file = number of regex matches on that turn's body, with
  a tie-break preferring user-role turns (mirroring run_retrieval.py's
  user-only default corpus). Files that score zero are ranked at the end
  via a secondary token-overlap heuristic so the metric can compute @50.

  turn_id used for scoring is rebuilt from the frontmatter:
    f"{session_id}_{turn_index}"   # matches run_retrieval.process_item_flat_index

OUTPUT:

  jsonl per entry in LongMemEval's retrieval_log format, containing the
  'retrieval_results' field with 'ranked_items' + 'metrics'. Downstream
  print_retrieval_metrics.py then consumes it:

    python src/evaluation/print_retrieval_metrics.py {out.jsonl}

USAGE:

  # 5-question spike, no wing filter:
  python longmemeval_adapter.py \\
      --lme  C:/tmp/lme-data/smoke_oracle.json \\
      --vault E:/knowledge/_lme_vault \\
      --out  C:/tmp/lme-data/retrieval_log_baseline.jsonl \\
      --limit 5

  # With wing metadata pre-filter (via vault.searchByFrontmatter):
  python longmemeval_adapter.py --lme oracle.json --vault vault/ \\
      --out log_wing.jsonl --limit 5 --use-wing-filter

DEPENDENCIES:

  python 3.11+, websockets>=15.0 (optional -- only if --transport ws)
  No sentence-transformers, no chromadb, no pgvector. The entire pipeline
  runs on vault-bridge primitives.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# LongMemEval-compatible metric helpers (copied from
# src/retrieval/eval_utils.py so the adapter is stand-alone).
# ---------------------------------------------------------------------------

def dcg(relevances: list[int], k: int) -> float:
    relevances = relevances[:k]
    if not relevances:
        return 0.0
    out = float(relevances[0])
    for i, r in enumerate(relevances[1:], start=2):
        out += r / math.log2(i + 1)
    return out


def ndcg(rankings: list[int], correct_docs: list[str], corpus_ids: list[str], k: int) -> float:
    rel = [1 if cid in set(correct_docs) else 0 for cid in corpus_ids]
    sorted_rel = [rel[idx] for idx in rankings[:k]]
    ideal = sorted(rel, reverse=True)
    idcg = dcg(ideal, k)
    if idcg == 0:
        return 0.0
    return dcg(sorted_rel, k) / idcg


def evaluate_retrieval(rankings: list[int], correct_docs: list[str], corpus_ids: list[str], k: int):
    recalled = {corpus_ids[idx] for idx in rankings[:k]}
    correct_set = set(correct_docs)
    recall_any = float(any(d in recalled for d in correct_set))
    recall_all = float(all(d in recalled for d in correct_set)) if correct_set else 0.0
    return recall_any, recall_all, ndcg(rankings, correct_docs, corpus_ids, k)


# ---------------------------------------------------------------------------
# vault-bridge transport. Two backends:
#   1) websockets client against the Obsidian plugin server
#   2) filesystem fallback -- reads .md files directly
# For the spike we default to fs fallback: Obsidian is not required and no
# port file / auth is needed. The ws transport is stubbed out and can be
# wired up once DRMT-03 stabilizes.
# ---------------------------------------------------------------------------

TOKEN_SPLIT = re.compile(r"[A-Za-z0-9']+")
STOP = {
    "the", "a", "an", "to", "of", "and", "is", "in", "it", "that", "this",
    "was", "for", "with", "on", "as", "at", "by", "from", "be", "are",
    "or", "do", "did", "what", "when", "where", "who", "why", "how", "i",
    "you", "me", "my", "your", "we", "our", "have", "has", "had",
}


def tokenize(text: str) -> list[str]:
    return [t.lower() for t in TOKEN_SPLIT.findall(text) if t.lower() not in STOP]


FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)


def parse_frontmatter(raw: str) -> tuple[dict[str, Any], str]:
    m = FM_RE.match(raw)
    if not m:
        return {}, raw
    meta: dict[str, Any] = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        v = v.strip()
        if v.startswith('"') and v.endswith('"'):
            v = v[1:-1]
        if v == "true":
            meta[k.strip()] = True
        elif v == "false":
            meta[k.strip()] = False
        else:
            try:
                meta[k.strip()] = int(v)
            except ValueError:
                meta[k.strip()] = v
    return meta, m.group(2)


@dataclass
class TurnRecord:
    path: Path
    meta: dict[str, Any]
    body: str
    tokens: set[str] = field(default_factory=set)


class FsVaultClient:
    """Filesystem-only replacement for vault-bridge. Mirrors the subset of
    methods the adapter needs. Does NOT talk to Obsidian; reads .md files
    off disk directly. Justified for benchmarking: we only read, never
    write."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._cache: dict[Path, TurnRecord] = {}

    def _load(self, path: Path) -> TurnRecord:
        cached = self._cache.get(path)
        if cached is not None:
            return cached
        raw = path.read_text(encoding="utf-8")
        meta, body = parse_frontmatter(raw)
        rec = TurnRecord(path=path, meta=meta, body=body, tokens=set(tokenize(body)))
        self._cache[path] = rec
        return rec

    def list_turns_for_question(self, qid: str) -> list[TurnRecord]:
        qdir = self.root / f"conv_{qid}"
        if not qdir.exists():
            return []
        records: list[TurnRecord] = []
        for p in sorted(qdir.rglob("turn_*.md")):
            records.append(self._load(p))
        return records

    def search(self, query: str, corpus: list[TurnRecord]) -> list[tuple[int, TurnRecord]]:
        """Emulates vault.search (regex-escaped substring, case-insensitive)
        restricted to `corpus`. Returns (score, record) sorted descending."""
        pat = re.compile(re.escape(query), re.IGNORECASE)
        scored: list[tuple[int, TurnRecord]] = []
        for rec in corpus:
            hits = len(pat.findall(rec.body))
            scored.append((hits, rec))
        scored.sort(key=lambda t: (-t[0], 0 if t[1].meta.get("role") == "user" else 1))
        return scored

    def rank(self, query: str, corpus: list[TurnRecord]) -> list[TurnRecord]:
        """Full ranking: exact-match score first, then token-overlap tie
        break so every corpus item ends up in the ranking (so recall@50 is
        defined)."""
        q_tokens = set(tokenize(query))
        primary = self.search(query, corpus)
        # Split into hit / no-hit groups and re-rank the no-hits by
        # token-overlap Jaccard-ish score.
        hits = [rec for score, rec in primary if score > 0]
        nohits = [rec for score, rec in primary if score == 0]
        nohits.sort(
            key=lambda r: (
                -len(q_tokens & r.tokens),
                0 if r.meta.get("role") == "user" else 1,
            )
        )
        return hits + nohits


# ---------------------------------------------------------------------------
# LongMemEval benchmark loop
# ---------------------------------------------------------------------------

def corpus_id_for(rec: TurnRecord) -> str:
    """Mirror run_retrieval.process_item_flat_index turn-level corpus_id:
       f"{session_id}_{turn_index}"    (user turns only in default mode)
    Assistant turns still get an id so we can rank them, but LongMemEval's
    correct_docs always reference user turns via answer_session_ids."""
    return f"{rec.meta.get('session_id')}_{rec.meta.get('turn_index')}"


def correct_docs_for_turn(corpus: list[TurnRecord], corpus_ids: list[str]) -> list[str]:
    """True turn-level correct docs: only user turns where
    has_answer=true. This is stricter than run_retrieval.py:272's
    substring match on 'answer' in corpus_id (which includes ALL turns
    from an evidence session), but matches how LongMemEval's
    has_answer label is constructed per turn in their original data.

    Rationale: run_retrieval.py builds its corpus_ids such that
    non-evidence turns in an evidence session are relabeled from
    'answer_*' to 'noans_*' (see lines 218-224), so the `"answer" in cid`
    filter IS correct in their pipeline. Our corpus IDs come from
    frontmatter and we preserve the original `answer_*` prefix on every
    turn of the session, so we need an explicit has_answer check."""
    correct: list[str] = []
    for rec, cid in zip(corpus, corpus_ids):
        if rec.meta.get("role") == "user" and rec.meta.get("has_answer") is True:
            correct.append(cid)
    return correct


def correct_docs_session(corpus: list[TurnRecord], corpus_ids: list[str]) -> list[str]:
    """Session-level ground truth: unique session_ids that contain at
    least one has_answer=true user turn."""
    sess = set()
    for rec in corpus:
        if rec.meta.get("role") == "user" and rec.meta.get("has_answer") is True:
            sid = rec.meta.get("session_id")
            if sid:
                sess.add(sid)
    return sorted(sess)


def run_benchmark(
    lme_path: Path,
    vault_root: Path,
    out_path: Path,
    limit: int | None,
    use_wing_filter: bool,
) -> dict[str, Any]:
    client = FsVaultClient(vault_root)
    with lme_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if limit is not None:
        data = data[:limit]

    per_type_acc: dict[str, list[float]] = {}
    all_entries: list[dict] = []

    with out_path.open("w", encoding="utf-8") as out_f:
        for entry in data:
            qid = entry["question_id"]
            qtype = entry["question_type"]
            query = entry["question"]

            corpus = client.list_turns_for_question(qid)
            if not corpus:
                print(f"warn: no vault dir for qid={qid}", file=sys.stderr)
                continue

            # wing filter is a no-op in fs client because the corpus is
            # already wing-scoped via list_turns_for_question. We keep the
            # flag to mirror the mempalace ablation: on a real vault.search
            # call, the wing filter would pre-select files by
            # searchByFrontmatter(wing=lme_{qid}) before search.
            if use_wing_filter:
                corpus = [r for r in corpus if r.meta.get("wing") == f"lme_{qid}"]

            ranked = client.rank(query, corpus)
            corpus_ids = [corpus_id_for(r) for r in corpus]
            # Pre-build turn->index lookup (O(1), and safe even if two
            # turns share identity by reference).
            idx_by_rec = {id(r): i for i, r in enumerate(corpus)}
            ranking_indices = [idx_by_rec[id(r)] for r in ranked]

            correct_turn = correct_docs_for_turn(corpus, corpus_ids)
            correct_sess = correct_docs_session(corpus, corpus_ids)
            session_corpus_ids = [r.meta.get("session_id") or "" for r in corpus]

            metrics = {"session": {}, "turn": {}}
            for k in (1, 3, 5, 10, 30, 50):
                r_any, r_all, nd = evaluate_retrieval(ranking_indices, correct_turn, corpus_ids, k)
                metrics["turn"][f"recall_any@{k}"] = r_any
                metrics["turn"][f"recall_all@{k}"] = r_all
                metrics["turn"][f"ndcg_any@{k}"] = nd
                s_any, s_all, s_nd = evaluate_retrieval(ranking_indices, correct_sess, session_corpus_ids, k)
                metrics["session"][f"recall_any@{k}"] = s_any
                metrics["session"][f"recall_all@{k}"] = s_all
                metrics["session"][f"ndcg_any@{k}"] = s_nd

            result = {
                "question_id": qid,
                "question_type": qtype,
                "question": query,
                "answer": entry.get("answer"),
                "question_date": entry.get("question_date"),
                "haystack_dates": entry.get("haystack_dates"),
                "haystack_session_ids": entry.get("haystack_session_ids"),
                "answer_session_ids": entry.get("answer_session_ids"),
                "retrieval_results": {
                    "query": query,
                    "ranked_items": [
                        {"corpus_id": corpus_ids[i], "text": corpus[i].body[:300]}
                        for i in ranking_indices[:50]
                    ],
                    "metrics": metrics,
                },
            }
            all_entries.append(result)
            per_type_acc.setdefault(qtype, []).append(metrics["turn"]["recall_all@5"])
            print(json.dumps(result, ensure_ascii=False), file=out_f)

    summary: dict[str, Any] = {
        "total_questions": len(all_entries),
        "per_type_turn_recall_all@5": {k: sum(v) / len(v) for k, v in per_type_acc.items() if v},
    }
    if all_entries:
        for level in ("turn", "session"):
            for k in (1, 3, 5, 10, 30, 50):
                for metric in ("recall_any", "recall_all", "ndcg_any"):
                    key = f"{metric}@{k}"
                    vals = [e["retrieval_results"]["metrics"][level][key] for e in all_entries]
                    summary[f"{level}_{key}"] = sum(vals) / len(vals)
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lme", required=True, help="LongMemEval JSON file (oracle/_s/_m)")
    ap.add_argument("--vault", required=True, help="Vault root populated by longmemeval_ingest.py")
    ap.add_argument("--out", required=True, help="Output retrieval log jsonl")
    ap.add_argument("--limit", type=int, default=None, help="Only benchmark first N questions")
    ap.add_argument("--use-wing-filter", action="store_true", help="Apply wing metadata pre-filter (ablation)")
    args = ap.parse_args()

    summary = run_benchmark(
        lme_path=Path(args.lme),
        vault_root=Path(args.vault),
        out_path=Path(args.out),
        limit=args.limit,
        use_wing_filter=args.use_wing_filter,
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
