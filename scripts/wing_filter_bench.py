#!/usr/bin/env python3
"""
wing_filter_bench.py -- R@k benchmark for vault-mind wing filtering.

Purpose
-------
Validate whether mempalace's "+34% from wing filtering" claim transfers to
Curry's research vault (E:/knowledge, ~762 .md files).

The claim (from mempalace README):
    Search all closets        -> R@10  60.9%
    Search within wing        -> R@10  73.1% (+12)
    Search wing + hall        -> R@10  84.8% (+24)
    Search wing + room        -> R@10  94.8% (+34)

This script measures the baseline -> wing filter lift on a local vault using
the same wing/room taxonomy that Phase 8 LOW will install in vault-mind.

It does NOT call the vault-mind WebSocket bridge. It reads markdown files
directly, embeds them with sentence-transformers, and queries a local
ChromaDB collection -- this keeps the benchmark self-contained and
reproducible from the command line. Results should be directionally
informative for the real plugin-backed path.

Inputs
------
    --vault PATH        Root of the vault (default: E:/knowledge)
    --queries PATH      Path to queries.json (see schema below)
    --model NAME        Embedding model (default: all-MiniLM-L6-v2, same as mempalace)
    --k INT             Top-k cutoff for R@k (default: 10)
    --limit INT         Optional cap on number of vault files to ingest
    --rebuild           Force re-embed even if cache exists

queries.json schema
-------------------
Array of objects. Each object is one evaluation query:

    [
      {
        "query": "What did we decide about ChromaDB vs Pinecone?",
        "wing": "research",                  // optional; enables wing-filtered run
        "gold_paths": [                      // ground-truth hits (relative to vault root)
          "04-Research/vector-db-decision.md"
        ]
      },
      ...
    ]

NOTE: we do NOT ship a queries.json. Curry must provide one before running --
we explicitly refuse to invent ground truth (see Round 2 report section 6).
A template is written to `queries.template.json` on first run if missing.

Outputs
-------
    - Printed table: R@k for {no-filter, wing-filter}
    - results-<timestamp>.json dump in scripts/bench_results/

Dependencies
------------
    pip install chromadb sentence-transformers
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# -- lazy imports so --help works without the deps installed -----------------

def _import_chromadb():
    import chromadb
    return chromadb


# ---------------------------------------------------------------------------
# Wing derivation -- mirrors the algorithm in Phase 8 LOW task 8.1
# ---------------------------------------------------------------------------

# E:/knowledge top-level folders (verified 2026-04-08, 20 dirs):
#   00-Index 01-Projects 02-Infrastructure 03-Trading 04-Research
#   05-Engineering 06-Daily 07-Protocols 08-Templates 09-Archive
#   10-External data Excalidraw KB ...
#
# Map numbered-prefix folder names to clean wing slugs.
WING_MAP = {
    "00-Index":          "index",
    "01-Projects":       "projects",
    "02-Infrastructure": "infrastructure",
    "03-Trading":        "trading",
    "04-Research":       "research",
    "05-Engineering":    "engineering",
    "06-Daily":          "daily",
    "07-Protocols":      "protocols",
    "08-Templates":      "templates",
    "09-Archive":        "archive",
    "10-External":       "external",
    "data":              "data",
    "Excalidraw":        "excalidraw",
    "KB":                "kb",
}

# Hall defaults keyed by wing. Keeps the taxonomy simple: one default hall
# per wing, with a small override list. In Phase 8 this moves to kb.yaml.
HALL_DEFAULT = {
    "research":       "hall_facts",
    "trading":        "hall_events",
    "projects":       "hall_facts",
    "daily":          "hall_events",
    "infrastructure": "hall_facts",
    "engineering":    "hall_facts",
    "protocols":      "hall_advice",
    "templates":      "hall_advice",
    "external":       "hall_general",
    "archive":        "hall_general",
}


def derive_wing_room_hall(rel_path: str) -> tuple[str, str, str]:
    """Map a vault-relative path to (wing, room, hall).

    rel_path uses forward slashes. Example:
        "04-Research/mempalace-round2-2026-04-08.md"
        -> ("research", "mempalace-round2-2026-04-08", "hall_facts")
    """
    parts = rel_path.replace("\\", "/").split("/")
    top = parts[0] if parts else ""
    wing = WING_MAP.get(top, top.lower() or "unknown")
    # Room = filename stem (no extension, lowercased)
    stem = Path(rel_path).stem.lower()
    # Normalize: strip non-alnum to hyphen, collapse runs
    room = "".join(c if c.isalnum() else "-" for c in stem)
    while "--" in room:
        room = room.replace("--", "-")
    room = room.strip("-") or "untitled"
    hall = HALL_DEFAULT.get(wing, "hall_general")
    return wing, room, hall


# ---------------------------------------------------------------------------
# Vault file loader
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class VaultNote:
    rel_path: str
    content: str
    wing: str
    room: str
    hall: str


def load_vault_notes(vault_root: Path, limit: Optional[int] = None) -> list[VaultNote]:
    notes: list[VaultNote] = []
    skip_dirs = {".git", ".obsidian", ".omc", ".smart-env", ".trash", "node_modules"}
    for md in vault_root.rglob("*.md"):
        if any(part in skip_dirs for part in md.parts):
            continue
        try:
            rel = md.relative_to(vault_root).as_posix()
        except ValueError:
            continue
        try:
            content = md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if not content.strip():
            continue
        wing, room, hall = derive_wing_room_hall(rel)
        notes.append(VaultNote(rel_path=rel, content=content, wing=wing, room=room, hall=hall))
        if limit and len(notes) >= limit:
            break
    return notes


# ---------------------------------------------------------------------------
# Indexing + querying via ChromaDB
# ---------------------------------------------------------------------------

def build_collection(notes: list[VaultNote], persist_dir: Path, model_name: str, rebuild: bool):
    chromadb = _import_chromadb()
    from chromadb.utils import embedding_functions

    client = chromadb.PersistentClient(path=str(persist_dir))
    col_name = f"vault_wing_bench_{model_name.replace('/', '_').replace('-', '_')}"

    if rebuild:
        try:
            client.delete_collection(col_name)
        except Exception:
            pass

    ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=model_name)

    # Idempotent: create if missing
    col = client.get_or_create_collection(col_name, embedding_function=ef)
    existing = col.count()
    if existing >= len(notes) and not rebuild:
        print(f"  [cache] collection has {existing} docs, skipping re-embed")
        return col

    # Simple chunking: one chunk per note, capped at 4000 chars to stay
    # within model context. For notes larger than 4000 chars we take the
    # first 4000 -- mempalace chunks at 800 with 100 overlap, but for this
    # benchmark we treat each note as one document (note-level R@k).
    ids, docs, metas = [], [], []
    for i, n in enumerate(notes):
        ids.append(f"note_{i}")
        docs.append(n.content[:4000])
        metas.append({
            "rel_path": n.rel_path,
            "wing": n.wing,
            "room": n.room,
            "hall": n.hall,
        })

    # Batch adds (ChromaDB default limit ~5000 per call)
    BATCH = 500
    for start in range(0, len(ids), BATCH):
        col.add(
            ids=ids[start:start + BATCH],
            documents=docs[start:start + BATCH],
            metadatas=metas[start:start + BATCH],
        )
    print(f"  [index] embedded {len(ids)} notes with {model_name}")
    return col


def run_queries(col, queries: list[dict], k: int) -> dict:
    """Run each query twice: no filter + wing filter. Return aggregated R@k."""
    no_filter_hits = 0
    wing_filter_hits = 0
    wing_filter_runs = 0
    per_query = []

    for q in queries:
        query_text = q["query"]
        gold_paths = set(q["gold_paths"])
        wing = q.get("wing")

        # Pass A: no filter
        r_a = col.query(query_texts=[query_text], n_results=k, include=["metadatas"])
        hit_paths_a = [m["rel_path"] for m in r_a["metadatas"][0]]
        hit_a = int(any(p in gold_paths for p in hit_paths_a))
        no_filter_hits += hit_a

        # Pass B: wing filter (only if query specifies a wing)
        hit_b = None
        hit_paths_b: list[str] = []
        if wing:
            r_b = col.query(
                query_texts=[query_text],
                n_results=k,
                where={"wing": wing},
                include=["metadatas"],
            )
            hit_paths_b = [m["rel_path"] for m in r_b["metadatas"][0]]
            hit_b = int(any(p in gold_paths for p in hit_paths_b))
            wing_filter_hits += hit_b
            wing_filter_runs += 1

        per_query.append({
            "query": query_text,
            "wing": wing,
            "gold": sorted(gold_paths),
            "no_filter_hit": hit_a,
            "no_filter_top": hit_paths_a,
            "wing_filter_hit": hit_b,
            "wing_filter_top": hit_paths_b,
        })

    return {
        "total_queries": len(queries),
        "no_filter_recall_at_k": no_filter_hits / len(queries) if queries else 0.0,
        "wing_filter_recall_at_k": (
            wing_filter_hits / wing_filter_runs if wing_filter_runs else None
        ),
        "wing_filter_queries": wing_filter_runs,
        "per_query": per_query,
    }


# ---------------------------------------------------------------------------
# Template writer
# ---------------------------------------------------------------------------

QUERY_TEMPLATE = [
    {
        "query": "REPLACE ME -- e.g. 'What did we decide about ChromaDB vs Pinecone?'",
        "wing": "research",
        "gold_paths": [
            "04-Research/REPLACE-ME.md"
        ]
    },
    {
        "query": "REPLACE ME -- e.g. 'How is the P_risk multiplier wired into Surplus?'",
        "wing": "trading",
        "gold_paths": [
            "03-Trading/REPLACE-ME.md"
        ]
    }
]


def write_template(path: Path) -> None:
    path.write_text(json.dumps(QUERY_TEMPLATE, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Wing-filter R@k benchmark for vault-mind")
    parser.add_argument("--vault", type=Path, default=Path("E:/knowledge"))
    parser.add_argument("--queries", type=Path, default=Path(__file__).parent / "queries.json")
    parser.add_argument("--model", default="all-MiniLM-L6-v2")
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--rebuild", action="store_true")
    parser.add_argument(
        "--persist-dir",
        type=Path,
        default=Path(__file__).parent / "bench_cache" / "chromadb",
    )
    args = parser.parse_args()

    if not args.vault.is_dir():
        print(f"ERROR: vault not found: {args.vault}", file=sys.stderr)
        return 2

    if not args.queries.is_file():
        template_path = args.queries.with_name("queries.template.json")
        write_template(template_path)
        print(f"ERROR: {args.queries} missing.")
        print(f"       wrote template -> {template_path}")
        print(f"       edit it, rename to {args.queries.name}, rerun.")
        return 2

    with args.queries.open(encoding="utf-8") as f:
        queries = json.load(f)

    print(f"vault:    {args.vault}")
    print(f"model:    {args.model}")
    print(f"queries:  {len(queries)}")
    print(f"k:        {args.k}")
    print()

    print("[1/3] loading vault notes...")
    t0 = time.time()
    notes = load_vault_notes(args.vault, limit=args.limit)
    print(f"  {len(notes)} notes in {time.time() - t0:.1f}s")

    args.persist_dir.mkdir(parents=True, exist_ok=True)

    print("[2/3] building / loading embedding index...")
    t0 = time.time()
    col = build_collection(notes, args.persist_dir, args.model, args.rebuild)
    print(f"  done in {time.time() - t0:.1f}s")

    print("[3/3] running queries...")
    t0 = time.time()
    agg = run_queries(col, queries, args.k)
    print(f"  done in {time.time() - t0:.1f}s")
    print()

    print("=" * 56)
    print(f"R@{args.k} results  (N={agg['total_queries']} total queries)")
    print("=" * 56)
    print(f"  no filter              : {agg['no_filter_recall_at_k']:.3f}")
    if agg["wing_filter_recall_at_k"] is not None:
        print(f"  wing filter (N={agg['wing_filter_queries']:>3}): "
              f"{agg['wing_filter_recall_at_k']:.3f}")
        delta = (agg['wing_filter_recall_at_k'] or 0) - agg['no_filter_recall_at_k']
        print(f"  lift                   : {delta:+.3f}")
    else:
        print("  wing filter            : skipped (no query had a 'wing' field)")
    print()

    out_dir = Path(__file__).parent / "bench_results"
    out_dir.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    out_file = out_dir / f"wing_filter_bench_{stamp}.json"
    out_file.write_text(json.dumps(agg, indent=2), encoding="utf-8")
    print(f"details -> {out_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
