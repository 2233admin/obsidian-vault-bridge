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


# ---------- exists() shape validation (sibling #1) ----------


@pytest.mark.asyncio
async def test_exists_happy_path_returns_bool() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={"exists": True}):
        result = await bridge.exists("notes/idea.md")
    assert result is True
    with mock.patch.object(bridge, "call", return_value={"exists": False}):
        result = await bridge.exists("notes/gone.md")
    assert result is False


@pytest.mark.asyncio
async def test_exists_raises_on_non_dict_response() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value="oops"):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.exists("any.md")
    assert "malformed exists response" in str(exc_info.value)
    assert "str" in str(exc_info.value)


@pytest.mark.asyncio
async def test_exists_raises_on_missing_key() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={}):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.exists("any.md")
    assert "missing 'exists'" in str(exc_info.value)


@pytest.mark.asyncio
async def test_exists_raises_on_wrong_type() -> None:
    """'exists' is an int instead of bool -> VaultBridgeError.

    Note: Python's bool is a subclass of int, but isinstance(1, bool) is False,
    so ints distinct from True/False are correctly rejected."""
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={"exists": 1}):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.exists("any.md")
    assert "int" in str(exc_info.value)
    assert "expected bool" in str(exc_info.value)


# ---------- search_by_tag() shape validation (sibling #2) ----------


@pytest.mark.asyncio
async def test_search_by_tag_happy_path_returns_list() -> None:
    bridge = _make_bridge()
    with mock.patch.object(
        bridge, "call", return_value={"files": ["a.md", "b.md"]}
    ):
        result = await bridge.search_by_tag("#project")
    assert result == ["a.md", "b.md"]


@pytest.mark.asyncio
async def test_search_by_tag_raises_on_non_dict_response() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value=["a.md"]):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.search_by_tag("#project")
    assert "malformed searchByTag response" in str(exc_info.value)


@pytest.mark.asyncio
async def test_search_by_tag_raises_on_missing_key() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={"count": 0}):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.search_by_tag("#project")
    assert "missing 'files'" in str(exc_info.value)


@pytest.mark.asyncio
async def test_search_by_tag_raises_on_wrong_type() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={"files": "a.md,b.md"}):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.search_by_tag("#project")
    assert "expected list" in str(exc_info.value)


# ---------- backlinks() shape validation (sibling #3) ----------


@pytest.mark.asyncio
async def test_backlinks_happy_path_returns_list() -> None:
    bridge = _make_bridge()
    payload = {"backlinks": [{"source": "a.md", "context": "see [[b]]"}]}
    with mock.patch.object(bridge, "call", return_value=payload):
        result = await bridge.backlinks("b.md")
    assert result == payload["backlinks"]


@pytest.mark.asyncio
async def test_backlinks_raises_on_non_dict_response() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value=None):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.backlinks("b.md")
    assert "malformed backlinks response" in str(exc_info.value)
    assert "NoneType" in str(exc_info.value)


@pytest.mark.asyncio
async def test_backlinks_raises_on_missing_key() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={"other": []}):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.backlinks("b.md")
    assert "missing 'backlinks'" in str(exc_info.value)


@pytest.mark.asyncio
async def test_backlinks_raises_on_wrong_type() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={"backlinks": 0}):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.backlinks("b.md")
    assert "expected list" in str(exc_info.value)


# ---------- capabilities() shape validation (sibling #4) ----------


@pytest.mark.asyncio
async def test_capabilities_happy_path_returns_list() -> None:
    bridge = _make_bridge()
    payload = {"methods": ["vault.read", "vault.create", "vault.search"]}
    with mock.patch.object(bridge, "call", return_value=payload):
        result = await bridge.capabilities()
    assert result == payload["methods"]


@pytest.mark.asyncio
async def test_capabilities_raises_on_non_dict_response() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value="vault.read,vault.create"):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.capabilities()
    assert "malformed listCapabilities response" in str(exc_info.value)


@pytest.mark.asyncio
async def test_capabilities_raises_on_missing_key() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={"capabilities": []}):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.capabilities()
    assert "missing 'methods'" in str(exc_info.value)


@pytest.mark.asyncio
async def test_capabilities_raises_on_wrong_type() -> None:
    bridge = _make_bridge()
    with mock.patch.object(bridge, "call", return_value={"methods": "read,create"}):
        with pytest.raises(VaultBridgeError) as exc_info:
            await bridge.capabilities()
    assert "expected list" in str(exc_info.value)


# ---------- Regression: KeyError no longer propagates from sibling sites ----------


@pytest.mark.asyncio
async def test_siblings_all_raise_vault_bridge_error_not_key_error() -> None:
    """Regression for the 4 sibling KeyError patterns fixed batched
    with #11. Before the fix, each site raised a bare KeyError on the
    empty-dict transport failure. After the fix, all 4 raise
    VaultBridgeError with a structured message."""
    bridge = _make_bridge()
    for method_name, args in [
        ("exists", ("any.md",)),
        ("search_by_tag", ("#tag",)),
        ("backlinks", ("any.md",)),
        ("capabilities", ()),
    ]:
        with mock.patch.object(bridge, "call", return_value={}):
            with pytest.raises(VaultBridgeError):
                await getattr(bridge, method_name)(*args)
