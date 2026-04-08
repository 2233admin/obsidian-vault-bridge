"""Tests for Bug #11: vault_bridge.py read() shape validation.

Verifies that malformed WebSocket responses raise VaultBridgeError with a
meaningful message instead of propagating a bare KeyError or AttributeError.

We mock VaultBridge.call() so no live WebSocket connection is needed.
"""

from __future__ import annotations

import unittest.mock as mock

import pytest

from vault_bridge import VaultBridge, VaultBridgeError


def _make_bridge() -> VaultBridge:
    """Return a VaultBridge instance without connecting."""
    return VaultBridge(url="ws://127.0.0.1:9999", token="test-token")


# ---------- read() happy path ----------


@pytest.mark.asyncio
async def test_read_happy_path_returns_string() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={"content": "hello world"}):
        result = await bridge.read("notes/idea.md")
    assert result == "hello world"


# ---------- read() malformed response shapes ----------


@pytest.mark.asyncio
async def test_read_raises_on_string_response() -> None:
    """Transport returns a bare string instead of a dict -> VaultBridgeError, not KeyError."""
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value="oops"):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.read("notes/idea.md")
    assert "malformed read response" in str(exc_info.value)
    assert "str" in str(exc_info.value)


@pytest.mark.asyncio
async def test_read_raises_on_missing_content_key() -> None:
    """Response dict lacks 'content' key -> VaultBridgeError."""
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={}):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.read("notes/idea.md")
    assert "missing 'content'" in str(exc_info.value)


@pytest.mark.asyncio
async def test_read_raises_on_wrong_content_type() -> None:
    """'content' is an int instead of str -> VaultBridgeError."""
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={"content": 42}):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.read("notes/idea.md")
    assert "int" in str(exc_info.value)


@pytest.mark.asyncio
async def test_read_error_response_raises_vault_bridge_error() -> None:
    """Server returns {"error": "..."} which means call() itself raises VaultBridgeError
    (set via _listen -> fut.set_exception).  Confirm read() propagates it."""
    bridge = _make_bridge()
    original_error = VaultBridgeError(code=-32001, message="not found: foo.md")
    with mock.patch.object(bridge, "call", side_effect=original_error):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.read("foo.md")
    assert exc_info.value.code == -32001


@pytest.mark.asyncio
async def test_read_raises_vault_bridge_error_not_key_error_on_empty_dict() -> None:
    """Regression: before the fix, {} raised KeyError('content').
    After the fix it must raise VaultBridgeError."""
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={}):
        with pytest.raises(VaultBridgeError):
            await bridge.read("any.md")


@pytest.mark.asyncio
async def test_read_raises_vault_bridge_error_not_attribute_error_on_none() -> None:
    """call() returning None should raise VaultBridgeError, not AttributeError."""
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value=None):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.read("any.md")
    assert "malformed read response" in str(exc_info.value)
