#!/usr/bin/env python3
# vault-save-hook: on Stop, extract session facts from Claude Code transcript
# and append a recap block to the vault's daily note. Stdlib-only, non-blocking.
# Fires from project .claude/settings.json Stop hook (after dogfood-hook).

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VAULT = Path(os.environ.get("VAULT_PATH", "E:/knowledge"))
DAILY_DIR = VAULT / "06-Daily"
SEEN_LOG = ROOT / ".vault-save.log"
FAIL_LOG = ROOT / ".vault-save.failed.log"

MIN_USER_MSGS = 3
MAX_BULLETS = 12
MAX_TITLE_LEN = 80


def load_transcript(path: str) -> list:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]
    except Exception:
        return []


def extract_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return " ".join(parts)
    return ""


def summarize(entries: list) -> dict:
    user_msgs: list[str] = []
    vault_writes: list[str] = []
    git_commits: list[str] = []
    file_edits: set[str] = set()

    for e in entries:
        msg = e.get("message") or {}
        role = msg.get("role") or e.get("type")

        if role == "user":
            content = msg.get("content") or e.get("content")
            text = extract_text(content).strip()
            # skip tool_result blocks masquerading as user turns
            if text and not text.startswith("<") and "tool_use_id" not in str(content):
                user_msgs.append(text)

        if role == "assistant":
            for block in msg.get("content", []) or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") != "tool_use":
                    continue
                name = block.get("name", "")
                inp = block.get("input", {}) or {}

                if name.startswith("mcp__vault-mind") or name.startswith("mcp__llm-wiki"):
                    op = name.split("__", 2)[-1]
                    if any(k in op.lower() for k in ("create", "modify", "append", "write")):
                        p = inp.get("path") or inp.get("filepath") or ""
                        if p:
                            vault_writes.append(f"{op} {p}")
                elif name in ("Edit", "Write", "NotebookEdit"):
                    p = inp.get("file_path", "")
                    if p:
                        file_edits.add(p)
                elif name == "Bash":
                    cmd = inp.get("command", "")
                    m = re.search(r"git\s+commit[^\n]*-m\s+['\"]([^'\"]+)", cmd)
                    if m:
                        git_commits.append(m.group(1).strip())

    return {
        "user_msgs": user_msgs,
        "vault_writes": vault_writes,
        "git_commits": git_commits,
        "file_edits": sorted(file_edits),
    }


def build_title(user_msgs: list[str]) -> str:
    if not user_msgs:
        return "ad-hoc session"
    first = user_msgs[0].splitlines()[0].strip()
    first = re.sub(r"\s+", " ", first)
    if len(first) > MAX_TITLE_LEN:
        first = first[: MAX_TITLE_LEN - 1] + "..."
    return first or "ad-hoc session"


def already_seen(sid: str) -> bool:
    if not sid or not SEEN_LOG.exists():
        return False
    try:
        return sid in SEEN_LOG.read_text(encoding="utf-8").splitlines()
    except Exception:
        return False


def mark_seen(sid: str) -> None:
    try:
        with SEEN_LOG.open("a", encoding="utf-8") as f:
            f.write(sid + "\n")
    except Exception:
        pass


def fail(msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    try:
        with FAIL_LOG.open("a", encoding="utf-8") as f:
            f.write(f"{ts}\t{msg}\n")
    except Exception:
        pass


def build_recap(now: datetime, sid: str, cwd: str, s: dict) -> str:
    hhmm = now.strftime("%H:%M")
    sid_short = (sid or "unknown")[:8]
    title = build_title(s["user_msgs"])

    lines = [
        "",
        f"## Session recap {hhmm} (sid:{sid_short})",
        "",
        f"- **Title:** {title}",
        f"- **cwd:** `{cwd}`",
    ]

    if s["user_msgs"]:
        lines.append(f"- **User turns:** {len(s['user_msgs'])}")
        preview = [m.splitlines()[0][:100] for m in s["user_msgs"][:MAX_BULLETS]]
        lines.append("")
        lines.append("### Prompts")
        for p in preview:
            lines.append(f"- {p}")

    if s["vault_writes"]:
        lines.append("")
        lines.append("### Vault writes")
        for w in s["vault_writes"][:MAX_BULLETS]:
            lines.append(f"- {w}")

    if s["file_edits"]:
        lines.append("")
        lines.append("### Files touched")
        for p in s["file_edits"][:MAX_BULLETS]:
            lines.append(f"- `{p}`")

    if s["git_commits"]:
        lines.append("")
        lines.append("### Commits")
        for c in s["git_commits"][:MAX_BULLETS]:
            lines.append(f"- {c}")

    lines.append("")
    return "\n".join(lines)


def write_daily(recap: str, now: datetime) -> None:
    if not DAILY_DIR.exists():
        fail(f"daily dir missing: {DAILY_DIR}")
        return
    daily = DAILY_DIR / f"{now.strftime('%Y-%m-%d')}.md"
    try:
        if not daily.exists():
            header = (
                f"---\ndate: {now.strftime('%Y-%m-%d')}\n"
                f"tags:\n  - daily\n---\n\n# {now.strftime('%Y-%m-%d')}\n"
            )
            daily.write_text(header, encoding="utf-8")
        with daily.open("a", encoding="utf-8") as f:
            f.write(recap)
    except Exception as e:
        fail(f"write daily failed: {e}")


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception:
        return

    sid = payload.get("session_id") or ""
    if already_seen(sid):
        return

    transcript_path = payload.get("transcript_path") or ""
    if not transcript_path or not Path(transcript_path).exists():
        return

    cwd = payload.get("cwd") or str(Path.cwd())
    entries = load_transcript(transcript_path)
    if not entries:
        return

    s = summarize(entries)

    # skip criteria: ephemeral (few prompts, no writes, no commits)
    has_substance = (
        len(s["user_msgs"]) >= MIN_USER_MSGS
        or s["vault_writes"]
        or s["git_commits"]
        or s["file_edits"]
    )
    if not has_substance:
        mark_seen(sid)
        return

    now = datetime.now()
    recap = build_recap(now, sid, cwd, s)
    write_daily(recap, now)
    mark_seen(sid)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
