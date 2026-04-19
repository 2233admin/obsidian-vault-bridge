#!/usr/bin/env python3
"""Link discovery -- scan the vault for missing [[wikilinks]].

Pass 1 (default, no-LLM): literal alias match across file titles + frontmatter
aliases + H1 headings. Cheap, deterministic, Karpathy-style grep-first.

Pass 2 (--with-llm, future): concept-level suggestions via LLM. Not implemented
in this skeleton -- stub exits with a notice.

Usage:
    python link_discovery.py <vault> [--output PATH] [--skip DIR]
                             [--include-archive] [--limit N]
                             [--with-llm]

Output:
    <vault>/.compile/link_suggestions.md (or --output)
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# per E:/knowledge/_CLAUDE.md "Do Not Touch"
DEFAULT_SKIP = {
    ".obsidian", ".trash", ".git", ".smart-env", ".omc",
    "Excalidraw", "KB", "08-Templates", "data",
}
ARCHIVE_DIRS = {"09-Archive", "10-External"}

MIN_ALIAS_LEN_ASCII = 4
MIN_ALIAS_LEN_CJK = 3

FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
WIKILINK_RE = re.compile(r"\[\[[^\]]+\]\]")
MDLINK_RE = re.compile(r"\[[^\]]*\]\([^)]+\)")
FRONTMATTER_RE = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)
H1_RE = re.compile(r"^#\s+(.+)$", re.MULTILINE)


@dataclass
class NoteEntry:
    path: Path
    title: str
    aliases: list[str] = field(default_factory=list)


@dataclass
class Suggestion:
    src: Path
    line_no: int
    match: str
    target_title: str
    target_path: Path


def is_cjk(s: str) -> bool:
    return any("\u4e00" <= c <= "\u9fff" for c in s)


def parse_frontmatter(text: str) -> dict:
    """Minimal YAML subset: strings, bracketed lists, bullet lists under key."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}
    fm = m.group(0)
    out: dict = {}
    current_key: str | None = None
    for raw in fm.splitlines():
        if raw.strip() in ("", "---"):
            continue
        if re.match(r"^[A-Za-z_][\w-]*\s*:", raw):
            k, _, v = raw.partition(":")
            k = k.strip()
            v = v.strip()
            if v.startswith("[") and v.endswith("]"):
                out[k] = [x.strip().strip("'\"") for x in v[1:-1].split(",") if x.strip()]
                current_key = None
            elif v:
                out[k] = v.strip("'\"")
                current_key = None
            else:
                out[k] = []
                current_key = k
        elif current_key and raw.lstrip().startswith("- "):
            val = raw.lstrip()[2:].strip().strip("'\"")
            lst = out.get(current_key)
            if isinstance(lst, list):
                lst.append(val)
    return out


def collect_aliases(path: Path, text: str) -> NoteEntry:
    fm = parse_frontmatter(text)
    aliases: list[str] = []
    raw_aliases = fm.get("aliases") or fm.get("alias") or []
    if isinstance(raw_aliases, str):
        raw_aliases = [raw_aliases]
    aliases.extend(raw_aliases)
    h1 = H1_RE.search(text)
    if h1:
        aliases.append(h1.group(1).strip())
    title = path.stem
    seen: set[str] = set()
    deduped: list[str] = []
    for name in [title, *aliases]:
        if not name or name in seen:
            continue
        seen.add(name)
        deduped.append(name)
    return NoteEntry(path=path, title=title, aliases=deduped)


def iter_vault_md(vault: Path, skip_dirs: set[str]):
    for md in vault.rglob("*.md"):
        rel_parts = md.relative_to(vault).parts
        if any(part in skip_dirs for part in rel_parts):
            continue
        yield md


def build_index(vault: Path, skip_dirs: set[str]) -> dict[str, NoteEntry]:
    """Map lowercase-alias -> NoteEntry (first-wins for collisions)."""
    index: dict[str, NoteEntry] = {}
    for md in iter_vault_md(vault, skip_dirs):
        try:
            text = md.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        entry = collect_aliases(md, text)
        for name in entry.aliases:
            min_len = MIN_ALIAS_LEN_CJK if is_cjk(name) else MIN_ALIAS_LEN_ASCII
            if len(name) < min_len:
                continue
            index.setdefault(name.lower(), entry)
    return index


def strip_noise(text: str) -> str:
    t = FRONTMATTER_RE.sub("", text, count=1)
    t = FENCE_RE.sub("", t)
    t = INLINE_CODE_RE.sub("", t)
    t = WIKILINK_RE.sub("", t)
    t = MDLINK_RE.sub("", t)
    return t


def scan_file(path: Path, text: str, index: dict[str, NoteEntry]) -> list[Suggestion]:
    cleaned = strip_noise(text)
    suggestions: list[Suggestion] = []
    seen_pairs: set[tuple[str, Path]] = set()
    for lineno, line in enumerate(cleaned.splitlines(), 1):
        line_lower = line.lower()
        if not line_lower.strip():
            continue
        for alias_lower, entry in index.items():
            if entry.path == path:
                continue
            key = (alias_lower, entry.path)
            if key in seen_pairs:
                continue
            if alias_lower not in line_lower:
                continue
            if not is_cjk(alias_lower):
                if not re.search(r"\b" + re.escape(alias_lower) + r"\b", line_lower):
                    continue
            suggestions.append(
                Suggestion(
                    src=path,
                    line_no=lineno,
                    match=alias_lower,
                    target_title=entry.title,
                    target_path=entry.path,
                )
            )
            seen_pairs.add(key)
    return suggestions


def render_report(
    vault: Path,
    suggestions: list[Suggestion],
    scanned: int,
    index_size: int,
) -> str:
    by_src: dict[Path, list[Suggestion]] = defaultdict(list)
    for s in suggestions:
        by_src[s.src].append(s)

    header = [
        f"# Link suggestions ({datetime.now().strftime('%Y-%m-%d %H:%M')})",
        "",
        f"- Vault: `{vault.as_posix()}`",
        f"- Files scanned: {scanned}",
        f"- Aliases indexed: {index_size}",
        f"- Suggestions: {len(suggestions)} across {len(by_src)} files",
        "",
        "Generated by `compiler/link_discovery.py`. Review manually, accept wanted",
        "links into the source notes, re-run to refresh.",
        "",
    ]
    body: list[str] = []
    for src in sorted(by_src):
        try:
            rel = src.relative_to(vault).as_posix()
        except ValueError:
            rel = src.as_posix()
        body.append(f"## {rel}")
        body.append("")
        for s in sorted(by_src[src], key=lambda x: (x.line_no, x.match)):
            try:
                tgt_rel = s.target_path.relative_to(vault).as_posix()
            except ValueError:
                tgt_rel = s.target_path.as_posix()
            body.append(
                f"- L{s.line_no}: `{s.match}` -> `[[{s.target_title}]]` ({tgt_rel})"
            )
        body.append("")
    return "\n".join(header + body)


def write_report(output: Path, text: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8")


def run(
    vault: Path,
    output: Path,
    skip_dirs: set[str],
    limit: int = 0,
) -> dict:
    index = build_index(vault, skip_dirs)
    suggestions: list[Suggestion] = []
    scanned = 0
    for md in iter_vault_md(vault, skip_dirs):
        if limit and scanned >= limit:
            break
        try:
            text = md.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        suggestions.extend(scan_file(md, text, index))
        scanned += 1

    report = render_report(vault, suggestions, scanned, len(index))
    write_report(output, report)
    return {
        "scanned": scanned,
        "index_size": len(index),
        "suggestions": len(suggestions),
        "output": str(output),
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("vault", type=Path)
    p.add_argument("--output", type=Path, default=None)
    p.add_argument("--skip", action="append", default=[])
    p.add_argument("--include-archive", action="store_true")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--with-llm", action="store_true")
    args = p.parse_args(argv)

    vault = args.vault.resolve()
    if not vault.exists():
        print(f"error: vault {vault} not found", file=sys.stderr)
        return 2

    skip = set(DEFAULT_SKIP) | set(args.skip)
    if not args.include_archive:
        skip |= ARCHIVE_DIRS

    if args.with_llm:
        print(
            "[link_discovery] --with-llm is reserved for Phase 2 (not implemented). "
            "Running literal pass only.",
            file=sys.stderr,
        )

    # default: project-local .compile/ (CWD), not inside the vault -- avoid
    # polluting Obsidian's indexed file tree
    output = args.output or (Path.cwd() / ".compile" / "link_suggestions.md")
    stats = run(vault, output, skip, limit=args.limit)
    print(
        f"[link_discovery] scanned={stats['scanned']} "
        f"aliases={stats['index_size']} suggestions={stats['suggestions']} "
        f"-> {stats['output']}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
