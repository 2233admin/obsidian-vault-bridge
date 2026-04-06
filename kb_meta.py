#!/usr/bin/env python3
"""KB metadata engine -- zero-dependency CLI for knowledge base management.

Usage:
    python kb_meta.py init <vault> <topic>
    python kb_meta.py diff <vault> <topic>
    python kb_meta.py update-hash <vault> <topic> <file>
    python kb_meta.py update-index <vault> <topic>
    python kb_meta.py check-links <vault> <topic>
    python kb_meta.py vitality <vault> <topic>
    python kb_meta.py log-access <vault> <topic> <article>

All commands output JSON to stdout for machine consumption.
"""

import hashlib
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path


def meta_path(vault: str, topic: str) -> Path:
    return Path(vault) / topic / "_meta.json"


def load_meta(vault: str, topic: str) -> dict:
    p = meta_path(vault, topic)
    if p.exists():
        return json.loads(p.read_text("utf-8-sig"))
    return {"topic": topic, "created": today(), "sources": {}, "access_log": {}}


def save_meta(vault: str, topic: str, meta: dict) -> None:
    p = meta_path(vault, topic)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(meta, indent=2, ensure_ascii=False), "utf-8")
        tmp.replace(p)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def now_iso() -> str:
    from datetime import timezone
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def file_hash(path: Path) -> str:
    h = hashlib.blake2b(digest_size=8)
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_frontmatter(text: str) -> dict:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    fm = {}
    for line in text[4:end].split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        colon = line.find(":")
        if colon == -1:
            continue
        key = line[:colon].strip()
        val = line[colon + 1:].strip()
        if val.startswith('"') and val.endswith('"'):
            val = val[1:-1]
        elif val.startswith("'") and val.endswith("'"):
            val = val[1:-1]
        fm[key] = val
    return fm


def extract_wikilinks(text: str) -> list[str]:
    return [m.group(1).split("#")[0].strip() for m in re.finditer(r"\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]", text) if not m.group(1).strip().startswith("#")]


def walk_md(base: Path) -> list[Path]:
    results = []
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if d not in (".obsidian", "node_modules", ".git", "schema", ".trash") and not d.startswith("_"))
        for f in sorted(files):
            if f.endswith(".md"):
                results.append(Path(root) / f)
    results.sort()
    return results


# --- Commands ---

def cmd_init(vault: str, topic: str) -> dict:
    meta = load_meta(vault, topic)
    if "created" not in meta:
        meta["created"] = today()
    if "sources" not in meta:
        meta["sources"] = {}
    if "access_log" not in meta:
        meta["access_log"] = {}
    save_meta(vault, topic, meta)
    return {"ok": True, "topic": topic, "meta_path": str(meta_path(vault, topic))}


def cmd_diff(vault: str, topic: str) -> dict:
    meta = load_meta(vault, topic)
    raw_dir = Path(vault) / topic / "raw"
    if not raw_dir.exists():
        return {"new": [], "changed": [], "deleted": [], "unchanged": []}

    current_files = {}
    for f in walk_md(raw_dir):
        rel = f.relative_to(Path(vault) / topic).as_posix()
        current_files[rel] = file_hash(f)

    known = meta.get("sources", {})
    new, changed, unchanged = [], [], []
    for rel, h in sorted(current_files.items()):
        if rel not in known:
            new.append(rel)
        elif known[rel].get("hash") != h:
            changed.append(rel)
        else:
            unchanged.append(rel)

    deleted = [r for r in sorted(known) if r not in current_files]

    return {"new": new, "changed": changed, "deleted": deleted, "unchanged": unchanged}


def cmd_update_hash(vault: str, topic: str, file_rel: str) -> dict:
    file_rel = Path(file_rel).as_posix()
    meta = load_meta(vault, topic)
    full = Path(vault) / topic / file_rel
    if not full.exists():
        return {"error": f"File not found: {file_rel}"}
    h = file_hash(full)
    meta.setdefault("sources", {})[file_rel] = {
        "hash": h,
        "compiled_at": now_iso(),
    }
    save_meta(vault, topic, meta)
    return {"ok": True, "file": file_rel, "hash": h}


def cmd_update_index(vault: str, topic: str) -> dict:
    base = Path(vault) / topic
    wiki = base / "wiki"
    if not wiki.exists():
        return {"error": "wiki/ directory not found"}

    def scan_dir(subdir: str) -> list[dict]:
        d = wiki / subdir
        if not d.exists():
            return []
        rows = []
        for f in sorted(d.iterdir()):
            if not f.name.endswith(".md") or f.name.startswith("_"):
                continue
            text = f.read_text("utf-8-sig", errors="replace")
            # extract first non-heading, non-frontmatter paragraph as one-liner
            lines = text.split("\n")
            one_liner = ""
            in_fm = False
            for line in lines:
                if line.strip() == "---":
                    in_fm = not in_fm
                    continue
                if in_fm:
                    continue
                if line.startswith("#"):
                    continue
                stripped = line.strip()
                if stripped:
                    one_liner = stripped[:150]
                    break
            rows.append({
                "file": f"{subdir}/{f.stem}",
                "one_liner": one_liner,
            })
        return rows

    summaries = scan_dir("summaries")
    concepts = scan_dir("concepts")
    queries = scan_dir("queries")

    # count raw sources
    raw_dir = base / "raw"
    source_count = len(walk_md(raw_dir)) if raw_dir.exists() else 0

    # build index content
    def table_rows(items):
        return "\n".join(f"| [[{r['file']}]] | {r['one_liner']} |" for r in items) if items else ""

    index_content = (
        f"# {topic} Knowledge Base\n\n"
        f"> Auto-maintained index. Do not edit manually.\n"
        f"> Sources: {source_count} | Articles: {len(summaries)} | Concepts: {len(concepts)} | Last compiled: {today()}\n\n"
        f"## Summaries\n| File | One-liner |\n|------|-----------|\n{table_rows(summaries)}\n\n"
        f"## Concepts\n| File | One-liner |\n|------|-----------|\n{table_rows(concepts)}\n\n"
        f"## Queries\n| File | One-liner |\n|------|-----------|\n{table_rows(queries)}\n"
    )

    index_path = wiki / "_index.md"
    tmp = index_path.with_suffix(".tmp")
    try:
        tmp.write_text(index_content, "utf-8")
        tmp.replace(index_path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise

    return {
        "ok": True,
        "summaries": len(summaries),
        "concepts": len(concepts),
        "queries": len(queries),
        "source_count": source_count,
    }


def cmd_check_links(vault: str, topic: str) -> dict:
    base = Path(vault) / topic
    wiki = base / "wiki"
    if not wiki.exists():
        return {"broken": [], "total_links": 0}

    broken = []
    total = 0
    # pre-collect wiki subdirs once (avoid re-scanning per link)
    wiki_subdirs = [d for d in wiki.iterdir() if d.is_dir() and not d.name.startswith("_")]
    for f in walk_md(wiki):
        text = f.read_text("utf-8-sig", errors="replace")
        links = extract_wikilinks(text)
        rel_from = f.relative_to(base).as_posix()
        for link in links:
            total += 1
            candidates = [
                base / link,
                base / (link + ".md"),
                wiki / link,
                wiki / (link + ".md"),
            ]
            for subdir in wiki_subdirs:
                candidates.append(subdir / link)
                candidates.append(subdir / (link + ".md"))
            if not any(c.exists() for c in candidates):
                broken.append({"from": rel_from, "to": link})

    return {"broken": broken, "total_links": total}


def cmd_vitality(vault: str, topic: str) -> dict:
    meta = load_meta(vault, topic)
    base = Path(vault) / topic / "wiki"
    if not base.exists():
        return {"accessed": [], "never_accessed": [], "total": 0}

    access_log = meta.get("access_log", {})
    accessed, never_accessed = [], []

    for f in walk_md(base):
        if f.name.startswith("_"):
            continue
        rel = f.relative_to(Path(vault) / topic).as_posix()
        if rel not in access_log:
            never_accessed.append(rel)
        else:
            last = access_log[rel].get("last_access", "")
            count = access_log[rel].get("count", 0)
            accessed.append({"path": rel, "last_access": last, "count": count})

    # sort accessed by last_access ascending (oldest = most stale first)
    accessed.sort(key=lambda x: x["last_access"])

    return {
        "accessed": accessed,
        "never_accessed": sorted(never_accessed),
        "total": len(accessed) + len(never_accessed),
    }


def cmd_log_access(vault: str, topic: str, article: str) -> dict:
    meta = load_meta(vault, topic)
    log = meta.setdefault("access_log", {})
    entry = log.setdefault(article, {"count": 0})
    entry["count"] = entry.get("count", 0) + 1
    entry["last_access"] = now_iso()
    save_meta(vault, topic, meta)
    return {"ok": True, "article": article, "count": entry["count"]}


# --- CLI ---

def main():
    args = sys.argv[1:]
    if len(args) < 1:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    cmd = args[0]
    dispatch = {
        "init": lambda: cmd_init(args[1], args[2]),
        "diff": lambda: cmd_diff(args[1], args[2]),
        "update-hash": lambda: cmd_update_hash(args[1], args[2], args[3]),
        "update-index": lambda: cmd_update_index(args[1], args[2]),
        "check-links": lambda: cmd_check_links(args[1], args[2]),
        "vitality": lambda: cmd_vitality(args[1], args[2]),
        "log-access": lambda: cmd_log_access(args[1], args[2], args[3]),
    }

    if cmd not in dispatch:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    try:
        result = dispatch[cmd]()
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except IndexError:
        print(f"Missing arguments for '{cmd}'. See usage.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
