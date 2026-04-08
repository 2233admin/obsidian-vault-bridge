"""Tests for Bug #10: mcp_server.py structured VaultBridgeError handling.

Verifies that VaultBridgeError is caught before the broad Exception handler
and that the response carries a structured {"error": {"code": ..., "message": ...}}
payload instead of a plain "Error: ..." string.

Because the MCP server uses global state and a live WebSocket, we test the
_format_vault_error helper directly and exercise the call_tool path by
mocking vb.call at the VaultBridge layer.
"""

from __future__ import annotations

import json
import unittest.mock as mock

import pytest

from vault_bridge import VaultBridgeError
from mcp_server import _format_vault_error


# ---------- _format_vault_error unit tests ----------


def test_format_vault_error_basic() -> None:
    e = VaultBridgeError(code=-32001, message="not found: foo.md")
    result = _format_vault_error(e)
    assert result == {"error": {"code": -32001, "message": "not found: foo.md"}}


def test_format_vault_error_preserves_code() -> None:
    e = VaultBridgeError(code=-32602, message="invalid params")
    result = _format_vault_error(e)
    assert result["error"]["code"] == -32602


def test_format_vault_error_includes_data_when_present() -> None:
    e = VaultBridgeError(code=-32001, message="not found", data={"path": "foo.md"})
    result = _format_vault_error(e)
    assert result["error"]["data"] == {"path": "foo.md"}


def test_format_vault_error_omits_data_when_none() -> None:
    e = VaultBridgeError(code=-32001, message="not found")
    result = _format_vault_error(e)
    assert "data" not in result["error"]


def test_format_vault_error_returns_dict() -> None:
    e = VaultBridgeError(code=0, message="ok")
    assert isinstance(_format_vault_error(e), dict)


# ---------- call_tool structured error path ----------
# We patch get_bridge() so no live WebSocket is needed.


@pytest.mark.asyncio
async def test_call_tool_vault_bridge_error_returns_structured_json() -> None:
    """VaultBridgeError from vb.call() should produce structured JSON, not 'Error: ...'."""
    from mcp_server import call_tool

    bridge_mock = mock.AsyncMock()
    bridge_mock.call.side_effect = VaultBridgeError(
        code=-32001, message="not found: foo.md"
    )

    with mock.patch("mcp_server.get_bridge", return_value=bridge_mock):
        results = await call_tool("vault_read", {"path": "foo.md"})

    assert len(results) == 1
    text = results[0].text
    parsed = json.loads(text)
    assert parsed["error"]["code"] == -32001
    assert "not found" in parsed["error"]["message"]


@pytest.mark.asyncio
async def test_call_tool_bare_exception_falls_through_to_string() -> None:
    """Unexpected Exception (not VaultBridgeError) still produces 'Error: ...' string."""
    from mcp_server import call_tool

    bridge_mock = mock.AsyncMock()
    bridge_mock.call.side_effect = RuntimeError("oops something broke")

    with mock.patch("mcp_server.get_bridge", return_value=bridge_mock):
        results = await call_tool("vault_read", {"path": "foo.md"})

    assert len(results) == 1
    text = results[0].text
    assert text.startswith("Error:")
    assert "oops something broke" in text
    # Must NOT be valid JSON with an error.code structure
    try:
        parsed = json.loads(text)
        assert "error" not in parsed or "code" not in parsed.get("error", {})
    except json.JSONDecodeError:
        pass  # plain string is also acceptable


@pytest.mark.asyncio
async def test_call_tool_vault_bridge_error_with_data_included() -> None:
    from mcp_server import call_tool

    bridge_mock = mock.AsyncMock()
    bridge_mock.call.side_effect = VaultBridgeError(
        code=-32603, message="malformed", data={"raw": "oops"}
    )

    with mock.patch("mcp_server.get_bridge", return_value=bridge_mock):
        results = await call_tool("vault_read", {"path": "bad.md"})

    parsed = json.loads(results[0].text)
    assert parsed["error"]["data"] == {"raw": "oops"}


@pytest.mark.asyncio
async def test_call_tool_unknown_tool_not_affected() -> None:
    """Unknown tool name still returns the plain unknown-tool message."""
    from mcp_server import call_tool

    results = await call_tool("vault_nonexistent", {})
    assert "Unknown tool" in results[0].text
