"""Tests for DRMT-03: filesystem fallback in vault_bridge.py.

Covers _FilesystemFallback class and VaultBridge.connect() fallback path
when the Obsidian WebSocket server is unreachable.
"""

from __future__ import annotations

import pytest

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
