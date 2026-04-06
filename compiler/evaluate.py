#!/usr/bin/env python3
"""Agent evaluation and action execution for vault-mind Phase 5."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any

from kb_meta import extract_wikilinks, walk_md

VALID_ACTIONS = ("compile", "emerge", "reconcile", "prune", "challenge")
SCHEDULER_STATE_FILE = ".vault-mind-scheduler.json"
VAULT_LOG_FILE = "log.md"


@dataclass(slots=True)
class AgentSettings:
    vault_path: str
    config_path: str | None = None
    model_tier: str = "haiku"
    chunk_size: int = 1000
    chunk_overlap: int = 200
    auto_compile_threshold: int = 3
    night_mode_start: str = "22:00"
    night_mode_end: str = "06:00"
    days_since_emerge_threshold: int = 14
    contradiction_threshold: int = 1
    orphan_threshold: int = 10
    challenge_stale_days: int = 30
    challenge_stale_threshold: int = 3


@dataclass(slots=True)
class TopicSnapshot:
    topic: str
    dirty_files: list[str] = field(default_factory=list)
    unresolved_contradictions: int = 0
    orphan_count: int = 0
    stale_count: int = 0
    last_emerge_at: str | None = None


@dataclass(slots=True)
class VaultState:
    vault_path: str
    dirty_count: int
    dirty_topics: list[str]
    dirty_files_by_topic: dict[str, list[str]]
    days_since_emerge: int
    unresolved_contradictions: int
    orphan_count: int
    stale_count: int
    scheduler_state: str = "IDLE"
    mode: str = "auto"
    last_emerge_at: str | None = None
    topic_snapshots: list[TopicSnapshot] = field(default_factory=list)


@dataclass(slots=True)
class ScheduledAction:
    type: str
    target: str
    reason: str
    priority: int
    topics: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ActionResult:
    action: str
    status: str
    target: str
    reason: str
    priority: int
    mode: str
    scheduler_state: str
    started_at: str
    completed_at: str
    details: str = ""
    data: dict[str, Any] = field(default_factory=dict)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _to_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    try:
        if candidate.endswith("Z"):
            return datetime.fromisoformat(candidate.replace("Z", "+00:00"))
        return datetime.fromisoformat(candidate)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(candidate, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _one_line(value: str) -> str:
    return " ".join(value.strip().split())


def _strip_inline_comment(line: str) -> str:
    in_single = False
    in_double = False
    for index, char in enumerate(line):
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        elif char == "#" and not in_single and not in_double:
            return line[:index].rstrip()
    return line.rstrip()


def _parse_scalar(value: str) -> Any:
    candidate = value.strip()
    if not candidate:
        return ""
    if (
        (candidate.startswith('"') and candidate.endswith('"'))
        or (candidate.startswith("'") and candidate.endswith("'"))
    ):
        candidate = candidate[1:-1]
    if candidate.startswith("${") and candidate.endswith("}"):
        env_key = candidate[2:-1]
        return os.environ.get(env_key, "")
    lowered = candidate.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if re.fullmatch(r"-?\d+", candidate):
        return int(candidate)
    if re.fullmatch(r"-?\d+\.\d+", candidate):
        return float(candidate)
    return candidate


def parse_simple_yaml(raw: str) -> dict[str, Any]:
    """Parse the small subset of YAML used by vault-mind.yaml."""
    root: dict[str, Any] = {}
    stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]

    for raw_line in raw.splitlines():
        line = _strip_inline_comment(raw_line)
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        key, sep, value = line.strip().partition(":")
        if not sep:
            continue
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        value = value.strip()
        if not value:
            child: dict[str, Any] = {}
            parent[key] = child
            stack.append((indent, child))
            continue
        parent[key] = _parse_scalar(value)
    return root


def _find_config_path(explicit_path: str | None = None) -> Path | None:
    candidates: list[Path] = []
    if explicit_path:
        candidates.append(Path(explicit_path))
    repo_root = Path(__file__).resolve().parents[1]
    candidates.extend(
        [
            Path.cwd() / "vault-mind.yaml",
            Path.cwd().parent / "vault-mind.yaml",
            repo_root / "vault-mind.yaml",
        ]
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return None


def load_settings(
    config_path: str | None = None,
    vault_path_override: str | None = None,
) -> AgentSettings:
    config_file = _find_config_path(config_path)
    config: dict[str, Any] = {}
    if config_file is not None:
        config = parse_simple_yaml(config_file.read_text("utf-8-sig", errors="replace"))

    compiler_cfg = config.get("compiler", {}) if isinstance(config.get("compiler"), dict) else {}
    agent_cfg = config.get("agent", {}) if isinstance(config.get("agent"), dict) else {}

    vault_path = (
        vault_path_override
        or config.get("vault_path")
        or os.environ.get("VAULT_MIND_VAULT_PATH")
        or os.environ.get("VAULT_BRIDGE_VAULT")
        or ""
    )
    if not vault_path:
        raise ValueError("vault path is required (config, --vault, or VAULT_MIND_VAULT_PATH)")

    return AgentSettings(
        vault_path=str(Path(vault_path).resolve()),
        config_path=str(config_file) if config_file is not None else None,
        model_tier=str(compiler_cfg.get("model_tier", "haiku")),
        chunk_size=int(compiler_cfg.get("chunk_size", 1000)),
        chunk_overlap=int(compiler_cfg.get("chunk_overlap", 200)),
        auto_compile_threshold=int(compiler_cfg.get("auto_compile_threshold", 3)),
        night_mode_start=str(agent_cfg.get("night_mode_start", "22:00")),
        night_mode_end=str(agent_cfg.get("night_mode_end", "06:00")),
        days_since_emerge_threshold=int(agent_cfg.get("days_since_emerge_threshold", 14)),
        contradiction_threshold=int(agent_cfg.get("contradiction_threshold", 1)),
        orphan_threshold=int(agent_cfg.get("orphan_threshold", 10)),
        challenge_stale_days=int(agent_cfg.get("challenge_stale_days", 30)),
        challenge_stale_threshold=int(agent_cfg.get("challenge_stale_threshold", 3)),
    )


def scheduler_state_path(vault_path: str) -> Path:
    return Path(vault_path) / SCHEDULER_STATE_FILE


def read_scheduler_state(vault_path: str) -> dict[str, Any]:
    path = scheduler_state_path(vault_path)
    if not path.exists():
        return {"scheduler_state": "IDLE", "mode": "auto", "updated_at": None}
    try:
        return json.loads(path.read_text("utf-8-sig"))
    except json.JSONDecodeError:
        return {"scheduler_state": "IDLE", "mode": "auto", "updated_at": None}


def write_scheduler_state(vault_path: str, state: str, mode: str) -> dict[str, Any]:
    path = scheduler_state_path(vault_path)
    payload = {"scheduler_state": state, "mode": mode, "updated_at": _to_iso(_now_utc())}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), "utf-8")
    return payload


def _parse_clock_time(value: str) -> time:
    hour, minute = value.split(":", 1)
    return time(hour=int(hour), minute=int(minute))


def resolve_operating_mode(
    requested_mode: str,
    settings: AgentSettings,
    now: datetime | None = None,
) -> str:
    if requested_mode in {"day", "night"}:
        return requested_mode

    current = (now or datetime.now().astimezone()).time()
    start = _parse_clock_time(settings.night_mode_start)
    end = _parse_clock_time(settings.night_mode_end)

    if start <= end:
        is_night = start <= current < end
    else:
        is_night = current >= start or current < end
    return "night" if is_night else "day"


def _iter_topics(vault_path: str) -> list[Path]:
    root = Path(vault_path)
    if not root.exists():
        return []
    topics = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        if (child / "raw").exists() or (child / "wiki").exists():
            topics.append(child)
    return topics


def _run_kb_meta(args: list[str]) -> dict[str, Any]:
    kb_meta = Path(__file__).with_name("kb_meta.py")
    result = subprocess.run(
        [sys.executable, str(kb_meta), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0 and result.stderr:
        return {"error": result.stderr.strip()}
    try:
        return json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return {}


def _topic_dirty_files(vault_path: str, topic: str) -> list[str]:
    diff = _run_kb_meta(["diff", vault_path, topic])
    return [*diff.get("new", []), *diff.get("changed", [])]


def _count_unresolved_contradictions(topic_dir: Path) -> int:
    path = topic_dir / "wiki" / "_contradictions.md"
    if not path.exists():
        return 0
    text = path.read_text("utf-8-sig", errors="replace")
    return len(
        re.findall(
            r"^\*\*Resolution\*\*:\s*unresolved\b",
            text,
            flags=re.IGNORECASE | re.MULTILINE,
        )
    )


def _build_alias_map(topic_dir: Path) -> tuple[list[str], dict[str, str]]:
    wiki_dir = topic_dir / "wiki"
    if not wiki_dir.exists():
        return [], {}
    md_files = []
    aliases: dict[str, str] = {}
    for file_path in walk_md(wiki_dir):
        if file_path.name.startswith("_"):
            continue
        rel = file_path.relative_to(topic_dir).as_posix()
        md_files.append(rel)
        aliases.setdefault(rel, rel)
        aliases.setdefault(rel.removeprefix("wiki/"), rel)
        aliases.setdefault(file_path.stem, rel)
        aliases.setdefault(file_path.name, rel)
    return md_files, aliases


def _resolve_wikilink(link: str, aliases: dict[str, str]) -> str | None:
    candidate = link.split("#", 1)[0].strip().replace("\\", "/")
    if not candidate:
        return None
    direct = aliases.get(candidate)
    if direct:
        return direct
    with_suffix = candidate if candidate.endswith(".md") else f"{candidate}.md"
    direct = aliases.get(with_suffix)
    if direct:
        return direct
    stem = Path(candidate).stem
    return aliases.get(stem)


def _count_orphans(topic_dir: Path) -> int:
    md_files, aliases = _build_alias_map(topic_dir)
    if not md_files:
        return 0
    inbound: set[str] = set()
    for rel in md_files:
        full = topic_dir / rel
        text = full.read_text("utf-8-sig", errors="replace")
        for link in extract_wikilinks(text):
            resolved = _resolve_wikilink(link, aliases)
            if resolved:
                inbound.add(resolved)
    return sum(1 for rel in md_files if rel not in inbound)


def _count_stale_pages(
    vault_path: str,
    topic: str,
    stale_days: int,
    now: datetime | None = None,
) -> int:
    vitality = _run_kb_meta(["vitality", vault_path, topic])
    cutoff = (now or _now_utc()) - timedelta(days=stale_days)
    stale = len(vitality.get("never_accessed", []))
    for row in vitality.get("accessed", []):
        last_access = _parse_timestamp(str(row.get("last_access", "")))
        if last_access is None or last_access <= cutoff:
            stale += 1
    return stale


def _find_last_emerge(topic_dir: Path) -> datetime | None:
    emerge_file = topic_dir / "wiki" / "_emerge_latest.md"
    if not emerge_file.exists():
        return None
    return datetime.fromtimestamp(emerge_file.stat().st_mtime, tz=timezone.utc)


def collect_vault_state(
    settings: AgentSettings,
    mode: str = "auto",
    scheduler_state: str | None = None,
    now: datetime | None = None,
) -> VaultState:
    state_meta = read_scheduler_state(settings.vault_path)
    resolved_mode = resolve_operating_mode(mode, settings, now=now)
    current_state = scheduler_state or str(state_meta.get("scheduler_state", "IDLE"))

    dirty_files_by_topic: dict[str, list[str]] = {}
    topic_snapshots: list[TopicSnapshot] = []
    emerge_times: list[datetime] = []

    for topic_dir in _iter_topics(settings.vault_path):
        topic = topic_dir.name
        dirty_files = _topic_dirty_files(settings.vault_path, topic)
        if dirty_files:
            dirty_files_by_topic[topic] = dirty_files

        last_emerge = _find_last_emerge(topic_dir)
        if last_emerge is not None:
            emerge_times.append(last_emerge)

        topic_snapshots.append(
            TopicSnapshot(
                topic=topic,
                dirty_files=dirty_files,
                unresolved_contradictions=_count_unresolved_contradictions(topic_dir),
                orphan_count=_count_orphans(topic_dir),
                stale_count=_count_stale_pages(
                    settings.vault_path,
                    topic,
                    settings.challenge_stale_days,
                    now=now,
                ),
                last_emerge_at=_to_iso(last_emerge) if last_emerge else None,
            )
        )

    dirty_topics = sorted(dirty_files_by_topic)
    dirty_count = sum(len(files) for files in dirty_files_by_topic.values())
    unresolved = sum(snapshot.unresolved_contradictions for snapshot in topic_snapshots)
    orphan_count = sum(snapshot.orphan_count for snapshot in topic_snapshots)
    stale_count = sum(snapshot.stale_count for snapshot in topic_snapshots)

    if emerge_times:
        latest_emerge = max(emerge_times)
        days_since_emerge = max(0, int(((now or _now_utc()) - latest_emerge).days))
        last_emerge_at = _to_iso(latest_emerge)
    else:
        days_since_emerge = settings.days_since_emerge_threshold + 1
        last_emerge_at = None

    return VaultState(
        vault_path=settings.vault_path,
        dirty_count=dirty_count,
        dirty_topics=dirty_topics,
        dirty_files_by_topic=dirty_files_by_topic,
        days_since_emerge=days_since_emerge,
        unresolved_contradictions=unresolved,
        orphan_count=orphan_count,
        stale_count=stale_count,
        scheduler_state=current_state,
        mode=resolved_mode,
        last_emerge_at=last_emerge_at,
        topic_snapshots=topic_snapshots,
    )


def evaluate_actions(state: VaultState, settings: AgentSettings) -> list[ScheduledAction]:
    actions: list[ScheduledAction] = []

    if state.dirty_count > 0:
        actions.append(
            ScheduledAction(
                type="compile",
                target=", ".join(state.dirty_topics) if state.dirty_topics else "vault",
                reason=(
                    f"{state.dirty_count} dirty file(s)"
                    f" across {len(state.dirty_topics)} topic(s)"
                ),
                priority=1000 + state.dirty_count,
                topics=list(state.dirty_topics),
            )
        )

    if state.days_since_emerge >= settings.days_since_emerge_threshold:
        if state.last_emerge_at is None:
            emerge_reason = "no emerge report found yet"
        else:
            emerge_reason = (
                f"{state.days_since_emerge} day(s) since last emerge"
                f" (threshold {settings.days_since_emerge_threshold})"
            )
        actions.append(
            ScheduledAction(
                type="emerge",
                target="vault",
                reason=emerge_reason,
                priority=900
                + max(0, state.days_since_emerge - settings.days_since_emerge_threshold),
            )
        )

    if state.unresolved_contradictions >= settings.contradiction_threshold:
        actions.append(
            ScheduledAction(
                type="reconcile",
                target="vault",
                reason=(
                    f"{state.unresolved_contradictions} unresolved contradiction(s)"
                    f" (threshold {settings.contradiction_threshold})"
                ),
                priority=800 + state.unresolved_contradictions,
            )
        )

    if state.orphan_count >= settings.orphan_threshold:
        actions.append(
            ScheduledAction(
                type="prune",
                target="vault",
                reason=(
                    f"{state.orphan_count} orphan page(s)"
                    f" (threshold {settings.orphan_threshold})"
                ),
                priority=700 + state.orphan_count,
            )
        )

    if state.stale_count >= settings.challenge_stale_threshold:
        actions.append(
            ScheduledAction(
                type="challenge",
                target="vault",
                reason=(
                    f"{state.stale_count} stale page(s) older than"
                    f" {settings.challenge_stale_days} day(s)"
                ),
                priority=600 + state.stale_count,
            )
        )

    return sorted(actions, key=lambda item: (-item.priority, VALID_ACTIONS.index(item.type)))


def _parse_compile_report(stdout: str) -> dict[str, int]:
    def extract(label: str) -> int:
        match = re.search(rf"{re.escape(label)}\s*:\s*(\d+)", stdout)
        return int(match.group(1)) if match else 0

    return {
        "sources_compiled": extract("Sources compiled"),
        "concepts_created": extract("Concepts created"),
        "contradictions_found": extract("Contradictions"),
    }


def _compile_topics(
    topics: list[str],
    settings: AgentSettings,
) -> tuple[str, dict[str, Any]]:
    if not topics:
        return "No dirty topics to compile.", {"topics": [], "runs": []}

    compile_py = Path(__file__).with_name("compile.py")
    runs: list[dict[str, Any]] = []
    summary: list[str] = []

    for topic in topics:
        topic_path = Path(settings.vault_path) / topic
        command = [
            sys.executable,
            str(compile_py),
            str(topic_path),
            "--tier",
            settings.model_tier,
            "--chunk-size",
            str(settings.chunk_size),
            "--chunk-overlap",
            str(settings.chunk_overlap),
        ]
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=180,
        )
        parsed = _parse_compile_report(result.stdout)
        run = {
            "topic": topic,
            "ok": result.returncode == 0,
            "returncode": result.returncode,
            "stats": parsed,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
        runs.append(run)
        if result.returncode == 0:
            summary.append(f"{topic}: {parsed['sources_compiled']} source(s) compiled")
        else:
            summary.append(f"{topic}: compile failed ({result.stderr.strip() or 'unknown error'})")

    return "; ".join(summary), {"topics": topics, "runs": runs}


def execute_action(
    action: ScheduledAction,
    state: VaultState,
    settings: AgentSettings,
    mode: str,
) -> ActionResult:
    started_at = _to_iso(_now_utc())
    status = "ok"
    details = ""
    data: dict[str, Any] = {}

    if action.type == "compile":
        details, data = _compile_topics(action.topics or state.dirty_topics, settings)
        if not data.get("topics"):
            status = "skipped"
        elif any(not run["ok"] for run in data.get("runs", [])):
            status = "error"
    else:
        status = "not_implemented"
        details = (
            f"{action.type} runner is reserved for a later phase;"
            " Phase 5 only executes compile.py for real."
        )

    return ActionResult(
        action=action.type,
        status=status,
        target=action.target,
        reason=action.reason,
        priority=action.priority,
        mode=mode,
        scheduler_state="REPORT",
        started_at=started_at,
        completed_at=_to_iso(_now_utc()),
        details=details,
        data=data,
    )


def manual_action(action_type: str, state: VaultState) -> ScheduledAction:
    if action_type not in VALID_ACTIONS:
        raise ValueError(f"unknown action: {action_type}")
    return ScheduledAction(
        type=action_type,
        target=", ".join(state.dirty_topics) if action_type == "compile" else "vault",
        reason="manual trigger",
        priority=10_000,
        topics=list(state.dirty_topics) if action_type == "compile" else [],
    )


def append_log_entry(vault_path: str, result: ActionResult) -> Path:
    path = Path(vault_path) / VAULT_LOG_FILE
    if not path.exists():
        path.write_text("# Vault Log\n", "utf-8")

    lines = [
        f"## [{result.completed_at}] agent | {result.action} | {result.status}",
        f"- target: {_one_line(result.target)}",
        f"- mode: {result.mode}",
        f"- scheduler_state: {result.scheduler_state}",
        f"- priority: {result.priority}",
        f"- reason: {_one_line(result.reason)}",
    ]
    if result.details:
        lines.append(f"- details: {_one_line(result.details)}")

    with path.open("a", encoding="utf-8") as handle:
        handle.write("\n" + "\n".join(lines) + "\n")
    return path


def read_history(vault_path: str, limit: int = 20) -> list[dict[str, Any]]:
    path = Path(vault_path) / VAULT_LOG_FILE
    if not path.exists():
        return []

    entries: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    heading_re = re.compile(r"^## \[([^\]]+)\] agent \| ([^|]+) \| (.+)$")

    for raw_line in path.read_text("utf-8-sig", errors="replace").splitlines():
        line = raw_line.rstrip()
        heading = heading_re.match(line)
        if heading:
            if current:
                entries.append(current)
            current = {
                "timestamp": heading.group(1),
                "action": heading.group(2).strip(),
                "status": heading.group(3).strip(),
            }
            continue
        if current and line.startswith("- "):
            key, _, value = line[2:].partition(":")
            current[key.strip()] = value.strip()

    if current:
        entries.append(current)

    recent = list(reversed(entries[-limit:]))
    for entry in recent:
        if "priority" in entry:
            try:
                entry["priority"] = int(entry["priority"])
            except ValueError:
                pass
    return recent


def status_payload(settings: AgentSettings, mode: str = "auto") -> dict[str, Any]:
    state = collect_vault_state(settings, mode=mode)
    payload = asdict(state)
    payload["actions"] = [asdict(action) for action in evaluate_actions(state, settings)]
    return payload


def trigger_payload(
    settings: AgentSettings,
    action_name: str,
    mode: str = "auto",
) -> dict[str, Any]:
    state = collect_vault_state(settings, mode=mode, scheduler_state="ACTION")
    action = manual_action(action_name, state)
    result = execute_action(action, state, settings, state.mode)
    append_log_entry(settings.vault_path, result)
    return asdict(result)


def main() -> None:
    parser = argparse.ArgumentParser(description="vault-mind agent evaluation and action runner")
    parser.add_argument("--config", help="Path to vault-mind.yaml", default=None)
    parser.add_argument("--vault", help="Vault path override", default=None)
    parser.add_argument("--mode", choices=["day", "night", "auto"], default="auto")
    parser.add_argument("--status", action="store_true", help="Print current vault status")
    parser.add_argument("--history", action="store_true", help="Read agent history from log.md")
    parser.add_argument("--limit", type=int, default=20, help="History entry limit")
    parser.add_argument("--trigger", choices=VALID_ACTIONS, help="Run one action immediately")
    args = parser.parse_args()

    settings = load_settings(config_path=args.config, vault_path_override=args.vault)

    if args.history:
        history = read_history(settings.vault_path, limit=args.limit)
        print(json.dumps(history, indent=2, ensure_ascii=False))
        return

    if args.trigger:
        payload = trigger_payload(settings, args.trigger, mode=args.mode)
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return

    payload = status_payload(settings, mode=args.mode)
    print(json.dumps(payload, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
