"""Tests for DRMT-03: filesystem fallback in vault_bridge.py.

Covers _FilesystemFallback class and VaultBridge.connect() fallback path
when the Obsidian WebSocket server is unreachable.
"""

from __future__ import annotations

import json
import unittest.mock as mock

import pytest

import vault_bridge
from vault_bridge import VaultBridge, _FilesystemFallback


@pytest.fixture
def vault(tmp_path):
    (tmp_path / "README.md").write_text("obsidian vault bridge", encoding="utf-8")
    (tmp_path / "notes").mkdir()
    (tmp_path / "notes" / "a.md").write_text("note a", encoding="utf-8")
    return tmp_path


# ---------- connect() fallback path ----------


@pytest.mark.asyncio
async def test_connect_falls_back_when_ws_unreachable(vault):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    r = await vb.connect()
    assert r == {
        "ok": True,
        "mode": "filesystem",
        "note": "Obsidian not running -- limited operations available",
    }
    assert vb.is_filesystem_mode() is True


@pytest.mark.asyncio
async def test_connect_without_vault_path_raises(tmp_path):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token")  # no vault_path
    with pytest.raises(RuntimeError, match="Filesystem fallback requires vault_path"):
        await vb.connect()


# ---------- VaultBridge method delegation ----------


@pytest.mark.asyncio
async def test_read_delegates_to_fallback(vault):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    await vb.connect()
    content = await vb.read("README.md")
    assert "obsidian" in content.lower()


@pytest.mark.asyncio
async def test_exists_delegates_to_fallback(vault):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    await vb.connect()
    assert await vb.exists("README.md") is True
    assert await vb.exists("missing.md") is False


@pytest.mark.asyncio
async def test_list_delegates_to_fallback(vault):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    await vb.connect()
    result = await vb.list("")
    assert "README.md" in result["files"]
    assert "notes" in result["folders"]


@pytest.mark.asyncio
async def test_create_modify_delete_roundtrip(vault):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    await vb.connect()
    await vb.create("new.md", "hello")
    assert (vault / "new.md").read_text(encoding="utf-8") == "hello"
    await vb.modify("new.md", "world")
    assert (vault / "new.md").read_text(encoding="utf-8") == "world"
    await vb.delete("new.md")
    assert not (vault / "new.md").exists()


@pytest.mark.asyncio
async def test_dry_run_rejected_in_fallback(vault):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    await vb.connect()
    with pytest.raises(NotImplementedError, match="dry-run"):
        await vb.create("x.md", "c", dry_run=True)


@pytest.mark.asyncio
async def test_delete_force_rejected_in_fallback(vault):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    await vb.connect()
    with pytest.raises(NotImplementedError, match="delete options"):
        await vb.delete("README.md", force=True)


# ---------- _FilesystemFallback direct: path traversal + plugin-only methods ----------


@pytest.mark.asyncio
async def test_path_traversal_blocked(vault):
    fb = _FilesystemFallback(vault)
    for bad in ["../outside.txt", "..\\outside.txt", "notes/../../outside.txt"]:
        with pytest.raises(ValueError, match="traversal"):
            await fb.read(bad)


@pytest.mark.asyncio
async def test_absolute_path_rejected(vault):
    fb = _FilesystemFallback(vault)
    for bad in ["C:/Windows/system32/cmd.exe", "/etc/passwd"]:
        with pytest.raises(ValueError, match="traversal"):
            await fb.read(bad)


@pytest.mark.asyncio
async def test_stat_append_rename_mkdir(vault):
    fb = _FilesystemFallback(vault)
    # stat
    info = await fb.stat("README.md")
    assert info["type"] == "file" and info["size"] > 0
    dir_info = await fb.stat("notes")
    assert dir_info["type"] == "folder"
    # append
    await fb.append("README.md", "\nextra")
    assert (vault / "README.md").read_text(encoding="utf-8").endswith("extra")
    # mkdir + rename
    await fb.mkdir("fresh")
    assert (vault / "fresh").is_dir()
    await fb.rename("fresh", "renamed")
    assert not (vault / "fresh").exists()
    assert (vault / "renamed").is_dir()


@pytest.mark.asyncio
async def test_delete_directory_raises(vault):
    fb = _FilesystemFallback(vault)
    with pytest.raises(IsADirectoryError):
        await fb.delete("notes")


def test_is_filesystem_mode_false_before_connect(vault):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    assert vb.is_filesystem_mode() is False


# ---------- from_discovery() reads vault field ----------


def test_from_discovery_picks_up_vault_field(vault, tmp_path, monkeypatch):
    port_file = tmp_path / "port.json"
    port_file.write_text(
        json.dumps({"port": 1, "token": "t", "vault": str(vault)}),
        encoding="utf-8",
    )
    monkeypatch.setattr(vault_bridge, "DISCOVERY_FILE", port_file)
    vb = VaultBridge.from_discovery()
    assert vb._vault_path == vault.resolve()


def test_from_discovery_without_vault_field(tmp_path, monkeypatch):
    port_file = tmp_path / "port.json"
    port_file.write_text(json.dumps({"port": 1, "token": "t"}), encoding="utf-8")
    monkeypatch.setattr(vault_bridge, "DISCOVERY_FILE", port_file)
    vb = VaultBridge.from_discovery()
    assert vb._vault_path is None


# ---------- EVNT-03: connect_with_retry + sticky subs ----------


@pytest.fixture(autouse=False)
def _fast_sleep(monkeypatch):
    """Neutralise asyncio.sleep inside vault_bridge so backoff tests are instant."""
    async def _instant(_):
        return None
    monkeypatch.setattr(vault_bridge.asyncio, "sleep", _instant)


@pytest.mark.asyncio
async def test_connect_with_retry_succeeds_after_transient_failure(vault, _fast_sleep):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    calls = {"n": 0}

    async def fake_connect():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionRefusedError("boom")
        return {"ok": True, "mode": "websocket"}

    with mock.patch.object(vb, "connect", side_effect=fake_connect):
        result = await vb.connect_with_retry(max_attempts=6)
    assert calls["n"] == 3
    assert result["mode"] == "websocket"


@pytest.mark.asyncio
async def test_connect_with_retry_exhausts_falls_back_to_filesystem(vault, _fast_sleep):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))

    async def always_fail():
        raise ConnectionRefusedError("down")

    with mock.patch.object(vb, "connect", side_effect=always_fail):
        result = await vb.connect_with_retry(max_attempts=3)
    assert result == {
        "ok": True,
        "mode": "filesystem",
        "note": "Obsidian not running -- limited operations available",
    }
    assert vb.is_filesystem_mode() is True


@pytest.mark.asyncio
async def test_connect_with_retry_exhausts_without_vault_path_raises(_fast_sleep):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token")  # no vault_path

    async def always_fail():
        raise ConnectionRefusedError("down")

    with mock.patch.object(vb, "connect", side_effect=always_fail):
        with pytest.raises(ConnectionRefusedError, match="down"):
            await vb.connect_with_retry(max_attempts=2)


@pytest.mark.asyncio
async def test_connect_with_retry_rejects_zero_attempts():
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token")
    with pytest.raises(ValueError, match="max_attempts"):
        await vb.connect_with_retry(max_attempts=0)


@pytest.mark.asyncio
async def test_subscribe_stores_sticky_and_dedupes(vault):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    with mock.patch.object(vb, "call", return_value={"ok": True}):
        await vb.subscribe(["KB/**", "Daily/**"])
        await vb.subscribe(["KB/**", "Inbox/**"])  # KB/** is duplicate
    assert vb._sticky_subscriptions == ["KB/**", "Daily/**", "Inbox/**"]


@pytest.mark.asyncio
async def test_unsubscribe_removes_sticky(vault):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    with mock.patch.object(vb, "call", return_value={"ok": True}):
        await vb.subscribe(["KB/**", "Daily/**", "Inbox/**"])
        await vb.unsubscribe(["Daily/**"])
    assert vb._sticky_subscriptions == ["KB/**", "Inbox/**"]


@pytest.mark.asyncio
async def test_reconnect_loop_replays_sticky_subscriptions(vault, _fast_sleep):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    vb._sticky_subscriptions = ["KB/**", "Daily/**"]

    replayed: list[tuple[str, dict]] = []

    async def fake_connect():
        return {"ok": True, "mode": "websocket"}

    async def fake_call(method, params=None):
        replayed.append((method, params))
        return {"ok": True}

    with mock.patch.object(vb, "connect", side_effect=fake_connect):
        with mock.patch.object(vb, "call", side_effect=fake_call):
            await vb._reconnect_loop()

    assert replayed == [("events.subscribe", {"patterns": ["KB/**", "Daily/**"]})]
    assert vb._reconnecting is False


@pytest.mark.asyncio
async def test_reconnect_loop_skips_replay_when_filesystem_mode(vault, _fast_sleep):
    vb = VaultBridge("ws://127.0.0.1:1", "fake-token", vault_path=str(vault))
    vb._sticky_subscriptions = ["KB/**"]

    async def always_fail():
        raise ConnectionRefusedError("down")

    replayed: list = []

    async def fake_call(method, params=None):
        replayed.append((method, params))
        return {"ok": True}

    with mock.patch.object(vb, "connect", side_effect=always_fail):
        with mock.patch.object(vb, "call", side_effect=fake_call):
            await vb._reconnect_loop()

    assert replayed == []  # filesystem mode: no server to replay to
    assert vb.is_filesystem_mode() is True


@pytest.mark.asyncio
async def test_plugin_only_methods_raise(vault):
    fb = _FilesystemFallback(vault)
    for method, args in [
        ("search", ("q",)),
        ("graph", ()),
        ("get_metadata", ("x",)),
        ("search_by_tag", ("#t",)),
        ("search_by_frontmatter", ("k",)),
        ("backlinks", ("x",)),
        ("lint", ()),
        ("batch", ([],)),
        ("init", ()),
        ("wake_up", ()),
        ("check_duplicate", ("x",)),
        ("get_taxonomy", ()),
    ]:
        with pytest.raises(NotImplementedError, match="Obsidian not running"):
            await getattr(fb, method)(*args)
