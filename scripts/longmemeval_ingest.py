#!/usr/bin/env python3
"""
LongMemEval -> Obsidian vault ingester.

Converts a LongMemEval JSON file (oracle / _s / _m) into a tree of .md files
suitable for ingestion via vault-bridge / vault-mind. Each conversation turn
becomes its own .md file under longmemeval_vault/conv_{question_id}/sess_{N}/turn_{N}.md
with frontmatter that vault.searchByFrontmatter can filter on.

Why one .md per turn (chosen from two candidate layouts):
  A) one .md per session, ## headings per turn
  B) one .md per turn (this script)

Decision: option B.
- vault.search returns matches with file path + line context, not arbitrary
  byte offsets. With option A a single hit returns the whole multi-turn session
  file which floods the LLM context and breaks turn-level recall scoring.
  LongMemEval's evaluator needs turn-level granularity to compute
  recall_all@k against `has_answer: true` turns.
- vault.searchByFrontmatter operates per file. Per-turn frontmatter (role,
  has_answer, session_id, ts) lets the adapter filter at metadata level for
  free, mirroring the wing/room metadata-filter trick from mempalace
  (E:/knowledge/04-Research/mempalace-research-2026-04-08.md, +34% R@10).
- Tradeoff: 500 q * ~40 sess * ~12 turns ~= 240K small files for the _s set.
  That stresses Obsidian metadata cache (~1-5 min cold load on first open).
  For the spike we ingest a 5-question subset; full _s is feasible but should
  be done with Obsidian closed and the python `vault_bridge.py` filesystem
  fallback (DRMT-03) once it lands.

Frontmatter schema (every turn file):
  question_id: gpt4_2655b836      # which LongMemEval question this turn belongs to
  session_id: answer_4be1b6b4_2   # corpus_id at session level
  turn_id: answer_4be1b6b4_2_3    # corpus_id at turn level (mirrors run_retrieval.py)
  turn_index: 3                   # 1-based, matches LongMemEval i_turn+1
  role: user | assistant
  has_answer: true | false        # only on user turns (LongMemEval label)
  session_date: "2023/04/10 (Mon) 17:50"
  question_date: "2023/04/10 (Mon) 23:07"
  question_type: temporal-reasoning
  wing: lme_{question_id}         # mempalace-style filter key (per-question namespace)
  room: sess_{session_id}         # secondary filter

Body: just the raw turn `content`. No formatting tricks; we want vault.search
to find substrings exactly as they appear in the original.

Usage:
  python longmemeval_ingest.py \\
      --in  C:/Users/Administrator/AppData/Local/Temp/research/lme-data/longmemeval_oracle.json \\
      --out E:/knowledge/_lme_vault \\
      --limit 5            # spike: only first 5 questions

  # Full oracle ingest (~1500 sessions, ~15K turns, fits in vault):
  python longmemeval_ingest.py --in oracle.json --out E:/knowledge/_lme_vault

  # Dry-run -- print stats only, do not write:
  python longmemeval_ingest.py --in oracle.json --out /tmp/x --dry-run
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SAFE_NAME = re.compile(r"[^A-Za-z0-9_\-]+")


def slugify(s: str, max_len: int = 60) -> str:
    return SAFE_NAME.sub("_", s)[:max_len].strip("_") or "x"


def yaml_escape(v: Any) -> str:
    if v is None:
        return '""'
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    if any(c in s for c in ':#"\n') or s != s.strip():
        return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
    return s


def render_frontmatter(meta: dict[str, Any]) -> str:
    lines = ["---"]
    for k, v in meta.items():
        lines.append(f"{k}: {yaml_escape(v)}")
    lines.append("---")
    return "\n".join(lines)


@dataclass
class IngestStats:
    questions: int = 0
    sessions: int = 0
    turns_user: int = 0
    turns_assistant: int = 0
    has_answer_turns: int = 0
    files_written: int = 0
    bytes_written: int = 0
    skipped_existing: int = 0


def ingest(
    in_path: Path,
    out_root: Path,
    limit: int | None = None,
    dry_run: bool = False,
    overwrite: bool = False,
) -> IngestStats:
    if not in_path.exists():
        raise FileNotFoundError(f"input not found: {in_path}")

    with in_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list):
        raise ValueError("LongMemEval files are expected to be a JSON list of question objects")

    if limit is not None:
        data = data[:limit]

    stats = IngestStats(questions=len(data))

    if not dry_run:
        out_root.mkdir(parents=True, exist_ok=True)

    for entry in data:
        qid: str = entry["question_id"]
        qtype: str = entry["question_type"]
        question: str = entry["question"]
        answer: Any = entry.get("answer")
        qdate: str = entry.get("question_date", "")
        sess_ids: list[str] = entry.get("haystack_session_ids", [])
        sess_dates: list[str] = entry.get("haystack_dates", [])
        sessions: list[list[dict]] = entry.get("haystack_sessions", [])
        answer_sids: list[str] = entry.get("answer_session_ids", [])

        qdir = out_root / f"conv_{slugify(qid)}"
        if not dry_run:
            qdir.mkdir(parents=True, exist_ok=True)

        # _question.md -- the LongMemEval query itself, ground truth answer,
        # answer_session_ids. Useful for debugging the adapter, never indexed
        # as part of the haystack search corpus.
        qmeta = {
            "question_id": qid,
            "question_type": qtype,
            "question_date": qdate,
            "answer": answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False),
            "answer_session_ids": json.dumps(answer_sids, ensure_ascii=False),
            "wing": f"lme_{slugify(qid)}",
            "kind": "lme_question",
        }
        qbody = f"{render_frontmatter(qmeta)}\n\n# Question\n\n{question}\n"
        qfile = qdir / "_question.md"
        if dry_run:
            stats.bytes_written += len(qbody.encode("utf-8"))
        else:
            if qfile.exists() and not overwrite:
                stats.skipped_existing += 1
            else:
                qfile.write_text(qbody, encoding="utf-8")
                stats.files_written += 1
                stats.bytes_written += len(qbody.encode("utf-8"))

        for s_idx, (sid, sdate, session_turns) in enumerate(
            zip(sess_ids, sess_dates, sessions)
        ):
            stats.sessions += 1
            sdir = qdir / f"sess_{s_idx:03d}_{slugify(sid, 30)}"
            if not dry_run:
                sdir.mkdir(parents=True, exist_ok=True)

            for t_idx, turn in enumerate(session_turns):
                role = turn.get("role", "user")
                content = turn.get("content", "")
                has_answer = bool(turn.get("has_answer", False))
                if role == "user":
                    stats.turns_user += 1
                    if has_answer:
                        stats.has_answer_turns += 1
                else:
                    stats.turns_assistant += 1

                # corpus_id mirrors run_retrieval.process_item_flat_index for
                # turn-level granularity: f"{sid}_{i_turn+1}". This MUST match
                # the LongMemEval evaluator's expectation.
                turn_corpus_id = f"{sid}_{t_idx + 1}"

                meta = {
                    "question_id": qid,
                    "session_id": sid,
                    "turn_id": turn_corpus_id,
                    "turn_index": t_idx + 1,
                    "role": role,
                    "has_answer": has_answer,
                    "session_date": sdate,
                    "question_date": qdate,
                    "question_type": qtype,
                    "wing": f"lme_{slugify(qid)}",
                    "room": f"sess_{slugify(sid, 30)}",
                    "kind": "lme_turn",
                }
                body = f"{render_frontmatter(meta)}\n\n{content}\n"
                fname = f"turn_{t_idx + 1:03d}_{role}.md"
                fpath = sdir / fname

                if dry_run:
                    stats.bytes_written += len(body.encode("utf-8"))
                    continue

                if fpath.exists() and not overwrite:
                    stats.skipped_existing += 1
                    continue

                fpath.write_text(body, encoding="utf-8")
                stats.files_written += 1
                stats.bytes_written += len(body.encode("utf-8"))

    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="in_path", required=True, help="LongMemEval JSON file")
    ap.add_argument("--out", dest="out_root", required=True, help="vault root directory")
    ap.add_argument("--limit", type=int, default=None, help="only ingest first N questions")
    ap.add_argument("--dry-run", action="store_true", help="count stats, write nothing")
    ap.add_argument("--overwrite", action="store_true", help="overwrite existing turn files")
    args = ap.parse_args()

    stats = ingest(
        in_path=Path(args.in_path),
        out_root=Path(args.out_root),
        limit=args.limit,
        dry_run=args.dry_run,
        overwrite=args.overwrite,
    )
    print(json.dumps(stats.__dict__, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
