"""Tests for mcp_server._preflight_write_gate -- Python preflight safety gate.

Uses unittest.mock to avoid needing a live WebSocket connection.
Tests the single-op path (commit 5). Batch recursion tests are added in commit 6.
"""

from __future__ import annotations

import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from mcp.types import TextContent

# Import the gate function and constants directly
from mcp_server import _preflight_write_gate, WRITE_TOOLS_PATH_GATED, WRITE_TOOLS_CONTENT_GATED


# ---------- helpers ----------

async def gate(name: str, params: dict) -> dict | None:
    """Run the gate and return the parsed JSON payload, or None if it passes."""
    result = await _preflight_write_gate(name, params)
    if result is None:
        return None
    assert isinstance(result, TextContent)
    return json.loads(result.text)


def is_rejected(payload: dict | None, reason: str | None = None) -> bool:
    if payload is None:
        return False
    if payload.get("error") != "safety_gate_rejected":
        return False
    if reason is not None:
        return payload.get("reason") == reason
    return True


# ---------- path gate: single ops ----------

@pytest.mark.asyncio
async def test_vault_create_blocked_path_obsidian_config() -> None:
    payload = await gate("vault_create", {"path": ".obsidian/config.json", "content": "{}"})
    assert is_rejected(payload, "protected_path")
    assert payload["path"] == ".obsidian/config.json"


@pytest.mark.asyncio
async def test_vault_create_safe_path_passes() -> None:
    # Good content: no issues, no bridge read needed for create
    payload = await gate("vault_create", {"path": "notes/good.md", "content": "# Hello\n\nGood note.\n"})
    assert payload is None


@pytest.mark.asyncio
async def test_vault_delete_blocked_path_git_head() -> None:
    payload = await gate("vault_delete", {"path": ".git/HEAD"})
    assert is_rejected(payload, "protected_path")


@pytest.mark.asyncio
async def test_vault_delete_safe_path_passes() -> None:
    payload = await gate("vault_delete", {"path": "notes/deleteme.md"})
    assert payload is None


@pytest.mark.asyncio
async def test_vault_rename_from_checked() -> None:
    payload = await gate("vault_rename", {"from": ".obsidian/app.json", "to": "notes/ok.md"})
    assert is_rejected(payload, "protected_path")
    assert payload["path"] == ".obsidian/app.json"


@pytest.mark.asyncio
async def test_vault_rename_to_checked() -> None:
    payload = await gate("vault_rename", {"from": "notes/ok.md", "to": ".git/stolen.md"})
    assert is_rejected(payload, "protected_path")
    assert payload["path"] == ".git/stolen.md"


@pytest.mark.asyncio
async def test_vault_rename_both_safe_passes() -> None:
    payload = await gate("vault_rename", {"from": "notes/old.md", "to": "notes/new.md"})
    assert payload is None


@pytest.mark.asyncio
async def test_vault_mkdir_blocked_obsidian_plugins() -> None:
    # vault_mkdir is in WRITE_TOOLS_PATH_GATED (ADR Q2).
    # Not in TOOL_MAP, but _preflight_write_gate handles it directly.
    payload = await gate("vault_mkdir", {"path": ".obsidian/plugins"})
    assert is_rejected(payload, "protected_path")


@pytest.mark.asyncio
async def test_vault_mkdir_safe_passes() -> None:
    payload = await gate("vault_mkdir", {"path": "notes/new-folder"})
    assert payload is None


# ---------- content gate: create ----------

@pytest.mark.asyncio
async def test_vault_create_invalid_content_wikilink_mismatch() -> None:
    # Unclosed wikilink bracket
    payload = await gate("vault_create", {"path": "notes/good.md", "content": "see [[broken bracket\n"})
    assert is_rejected(payload, "content_validation_failed")
    assert "errors" in payload
    assert any("bracket" in e.lower() for e in payload["errors"])


@pytest.mark.asyncio
async def test_vault_create_invalid_content_unclosed_fence() -> None:
    payload = await gate("vault_create", {"path": "notes/broken.md", "content": "# Title\n\n```python\nunclosed\n"})
    assert is_rejected(payload, "content_validation_failed")
    assert any("code fence" in e.lower() for e in payload["errors"])


# ---------- content gate: modify (requires bridge.read mock) ----------

@pytest.mark.asyncio
async def test_vault_modify_safe_passes() -> None:
    original = "# Title\n\nOriginal content.\n"
    mock_vb = AsyncMock()
    mock_vb.call = AsyncMock(return_value={"content": original})
    with patch("mcp_server.get_bridge", return_value=mock_vb):
        payload = await gate("vault_modify", {"path": "notes/existing.md", "content": "# Title\n\nUpdated content.\n"})
    assert payload is None


@pytest.mark.asyncio
async def test_vault_modify_invalid_content_drops_wikilinks() -> None:
    original = "# Title\n\nSee [[ImportantLink]] for details.\n"
    mock_vb = AsyncMock()
    mock_vb.call = AsyncMock(return_value={"content": original})
    with patch("mcp_server.get_bridge", return_value=mock_vb):
        payload = await gate("vault_modify", {
            "path": "notes/existing.md",
            "content": "# Title\n\nDropped the link entirely.\n",
        })
    assert is_rejected(payload, "content_validation_failed")
    assert any("wikilink" in e.lower() or "dropped" in e.lower() for e in payload["errors"])


# ---------- read-only tools pass gate untouched ----------

@pytest.mark.asyncio
async def test_vault_read_passes_gate() -> None:
    # vault_read is not in WRITE_TOOLS_PATH_GATED or WRITE_TOOLS_CONTENT_GATED
    payload = await gate("vault_read", {"path": ".obsidian/config.json"})
    assert payload is None


@pytest.mark.asyncio
async def test_vault_list_passes_gate() -> None:
    payload = await gate("vault_list", {"path": ".git"})
    assert payload is None


@pytest.mark.asyncio
async def test_vault_search_passes_gate() -> None:
    payload = await gate("vault_search", {"query": "test"})
    assert payload is None


# ---------- WRITE_TOOLS_PATH_GATED and WRITE_TOOLS_CONTENT_GATED sets ----------

def test_write_tools_path_gated_has_six_entries() -> None:
    assert "vault_create" in WRITE_TOOLS_PATH_GATED
    assert "vault_modify" in WRITE_TOOLS_PATH_GATED
    assert "vault_append" in WRITE_TOOLS_PATH_GATED
    assert "vault_delete" in WRITE_TOOLS_PATH_GATED
    assert "vault_rename" in WRITE_TOOLS_PATH_GATED
    assert "vault_mkdir" in WRITE_TOOLS_PATH_GATED


def test_write_tools_content_gated_has_three_entries() -> None:
    assert WRITE_TOOLS_CONTENT_GATED == frozenset({"vault_create", "vault_modify", "vault_append"})
    assert "vault_mkdir" not in WRITE_TOOLS_CONTENT_GATED
    assert "vault_delete" not in WRITE_TOOLS_CONTENT_GATED
