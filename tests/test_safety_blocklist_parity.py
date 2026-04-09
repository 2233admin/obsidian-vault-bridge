"""Cross-language BLOCKED set parity test.

Pins that ``src/safety/bridge-safe-paths.ts`` and ``vault_safe_paths.py``
expose byte-identical blocklists. Editing one without the other fails
this test, catching drift at CI time instead of production time.

Closes W8 audit gap #3 flagged in progress.txt on 2026-04-08 (afternoon
session). V3 of the W8 evidence chain independently verified that the
TS and Python BLOCKED sets matched at sizes 81/15/5 on that date; this
test pins that invariant forward.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from vault_safe_paths import (
    ALLOWED_VAULT_EXTENSIONS,
    BLOCKED_DIRECTORIES,
    BLOCKED_EXTENSIONS,
)

_TS_SOURCE_PATH = (
    Path(__file__).parent.parent / "src" / "safety" / "bridge-safe-paths.ts"
)


def _extract_ts_set(ts_source: str, name: str) -> frozenset[str]:
    """Extract string literals from a ``new Set([...])`` declaration.

    Matches ``(export )?const NAME: ReadonlySet<string> = new Set([ ... ])``
    and returns the set of quoted string literals found between the
    brackets. Spread operators (``...OTHER``) are ignored -- the caller is
    expected to compose them by unioning the referenced sets.
    """
    pattern = re.compile(
        r"(?:export\s+)?const\s+" + re.escape(name) +
        r"\s*:\s*ReadonlySet<string>\s*=\s*new\s+Set\(\[(.*?)\]\)",
        re.DOTALL,
    )
    match = pattern.search(ts_source)
    if match is None:
        raise AssertionError(
            f"bridge-safe-paths.ts: could not find Set declaration for {name}"
        )
    body = match.group(1)
    literals = re.findall(r'"([^"]*)"|\'([^\']*)\'', body)
    return frozenset(double or single for double, single in literals)


@pytest.fixture(scope="module")
def ts_source() -> str:
    assert _TS_SOURCE_PATH.exists(), f"TS source missing at {_TS_SOURCE_PATH}"
    return _TS_SOURCE_PATH.read_text(encoding="utf-8")


def test_blocked_extensions_parity(ts_source: str) -> None:
    """BLOCKED_EXTENSIONS (composed from two sub-sets) must match byte-for-byte."""
    caveman = _extract_ts_set(ts_source, "_CAVEMAN_SKIP_EXTENSIONS")
    extra = _extract_ts_set(ts_source, "_VAULT_EXTRA_BLOCKED")
    ts_blocked = caveman | extra
    py_blocked = frozenset(BLOCKED_EXTENSIONS)
    drift = ts_blocked ^ py_blocked
    assert not drift, (
        "BLOCKED_EXTENSIONS drift between TS and Python:\n"
        f"  only in TS: {sorted(ts_blocked - py_blocked)}\n"
        f"  only in Python: {sorted(py_blocked - ts_blocked)}"
    )


def test_blocked_directories_parity(ts_source: str) -> None:
    ts_dirs = _extract_ts_set(ts_source, "BLOCKED_DIRECTORIES")
    py_dirs = frozenset(BLOCKED_DIRECTORIES)
    drift = ts_dirs ^ py_dirs
    assert not drift, (
        "BLOCKED_DIRECTORIES drift between TS and Python:\n"
        f"  only in TS: {sorted(ts_dirs - py_dirs)}\n"
        f"  only in Python: {sorted(py_dirs - ts_dirs)}"
    )


def test_allowed_extensions_parity(ts_source: str) -> None:
    ts_allowed = _extract_ts_set(ts_source, "ALLOWED_VAULT_EXTENSIONS")
    py_allowed = frozenset(ALLOWED_VAULT_EXTENSIONS)
    drift = ts_allowed ^ py_allowed
    assert not drift, (
        "ALLOWED_VAULT_EXTENSIONS drift between TS and Python:\n"
        f"  only in TS: {sorted(ts_allowed - py_allowed)}\n"
        f"  only in Python: {sorted(py_allowed - ts_allowed)}"
    )


def test_blocklist_sizes_pinned() -> None:
    """W8 V3 snapshot: 81/15/5.

    The W8 critic independently counted these sizes on 2026-04-08 and
    confirmed TS/Python parity. Any size change requires synchronized
    edits to both files AND this counter -- the triple guard makes
    drift loud.
    """
    assert len(BLOCKED_EXTENSIONS) == 81, (
        f"BLOCKED_EXTENSIONS size drift: {len(BLOCKED_EXTENSIONS)} != 81"
    )
    assert len(BLOCKED_DIRECTORIES) == 15, (
        f"BLOCKED_DIRECTORIES size drift: {len(BLOCKED_DIRECTORIES)} != 15"
    )
    assert len(ALLOWED_VAULT_EXTENSIONS) == 5, (
        f"ALLOWED_VAULT_EXTENSIONS size drift: {len(ALLOWED_VAULT_EXTENSIONS)} != 5"
    )
