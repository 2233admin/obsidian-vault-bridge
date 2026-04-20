"""Async Python client for Obsidian Vault Bridge WebSocket server."""

from __future__ import annotations

import asyncio
import json
import logging
import traceback
from pathlib import Path
from typing import Any, Callable

DISCOVERY_FILE = Path.home() / ".obsidian-ws-port"
DEFAULT_TIMEOUT = 30.0
LOGGER = logging.getLogger(__name__)


class VaultBridgeError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


def _require_response_shape(
    method: str, response: Any, key: str, expected_type: type
) -> Any:
    """Validate a response dict has the expected key and value type.

    Mirrors the shape-check pattern introduced for read() in commit
    8bd8f4b (#11). Centralizes the check so sibling sites (exists,
    search_by_tag, backlinks, capabilities) reject malformed responses
    with a structured VaultBridgeError(-32603) instead of raising a
    bare KeyError or AttributeError from a later deref.

    Raises:
        VaultBridgeError(-32603) if response is not a dict, is missing
        the key, or the value at that key is not the expected type.

    Returns:
        The validated value at response[key].
    """
    if not isinstance(response, dict):
        raise VaultBridgeError(
            -32603,
            f"malformed {method} response: expected dict, got "
            f"{type(response).__name__}: {response!r}",
        )
    if key not in response:
        raise VaultBridgeError(
            -32603,
            f"malformed {method} response: missing {key!r} key: {response!r}",
        )
    value = response[key]
    if not isinstance(value, expected_type):
        raise VaultBridgeError(
            -32603,
            f"malformed {method} response: {key!r} is "
            f"{type(value).__name__}, expected {expected_type.__name__}: "
            f"{response!r}",
        )
    return value


class _FilesystemFallback:
    """Direct filesystem I/O when the Obsidian WS server is unreachable.

    Exposes the same async surface as VaultBridge for vault.{read,stat,list,
    exists,create,modify,append,delete,rename,mkdir}. Methods that require
    Obsidian plugin features (search, graph, metadata, tags, frontmatter,
    backlinks, lint, batch, init, wakeUp, checkDuplicate, getTaxonomy)
    raise NotImplementedError.
    """

    def __init__(self, vault_path: str | Path):
        self._vault_path = Path(vault_path).expanduser().resolve()

    def _resolve_path(self, path: str, *, allow_root: bool = False) -> Path:
        normalized = path.replace("\\", "/").strip()
        if normalized in {"", "."}:
            if allow_root:
                return self._vault_path
            raise ValueError("path required")

        p = Path(normalized)
        if p.is_absolute() or ".." in p.parts:
            raise ValueError(f"path traversal blocked: {path}")

        candidate = (self._vault_path / p).resolve()
        try:
            candidate.relative_to(self._vault_path)
        except ValueError as exc:
            raise ValueError(f"path traversal blocked: {path}") from exc
        return candidate

    def _relative_path(self, path: Path) -> str:
        return path.relative_to(self._vault_path).as_posix()

    async def read(self, path: str) -> str:
        return self._resolve_path(path).read_text("utf-8")

    async def stat(self, path: str) -> dict:
        target = self._resolve_path(path)
        if not target.exists():
            raise FileNotFoundError(path)
        if target.is_dir():
            return {
                "type": "folder",
                "path": self._relative_path(target),
                "name": target.name,
                "children": len(list(target.iterdir())),
            }
        info = target.stat()
        return {
            "type": "file",
            "path": self._relative_path(target),
            "name": target.name,
            "ext": target.suffix.lstrip("."),
            "size": info.st_size,
            "ctime": int(info.st_ctime * 1000),
            "mtime": int(info.st_mtime * 1000),
        }

    async def list(self, path: str = "") -> dict:
        folder = self._resolve_path(path, allow_root=True)
        if not folder.exists():
            raise FileNotFoundError(path or str(self._vault_path))
        if not folder.is_dir():
            raise NotADirectoryError(path)

        files: list[str] = []
        folders: list[str] = []
        for child in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
            rel = self._relative_path(child)
            if child.is_dir():
                folders.append(rel)
            else:
                files.append(rel)
        return {"files": files, "folders": folders}

    async def exists(self, path: str) -> bool:
        return self._resolve_path(path).exists()

    async def create(self, path: str, content: str = "") -> dict:
        target = self._resolve_path(path)
        if target.exists():
            raise FileExistsError(path)
        with target.open("x", encoding="utf-8") as handle:
            handle.write(content)
        return {"ok": True, "path": self._relative_path(target)}

    async def modify(self, path: str, content: str) -> dict:
        target = self._resolve_path(path)
        if not target.is_file():
            raise FileNotFoundError(path)
        target.write_text(content, encoding="utf-8")
        return {"ok": True, "path": self._relative_path(target)}

    async def append(self, path: str, content: str) -> dict:
        target = self._resolve_path(path)
        if not target.is_file():
            raise FileNotFoundError(path)
        with target.open("a", encoding="utf-8") as handle:
            handle.write(content)
        return {"ok": True, "path": self._relative_path(target)}

    async def delete(self, path: str) -> dict:
        target = self._resolve_path(path)
        if not target.exists():
            raise FileNotFoundError(path)
        if target.is_dir():
            raise IsADirectoryError(path)
        LOGGER.warning(
            "Obsidian not running -- deleting %s directly instead of moving to trash",
            path,
        )
        target.unlink()
        return {"ok": True, "path": self._relative_path(target)}

    async def rename(self, from_path: str, to_path: str) -> dict:
        source = self._resolve_path(from_path)
        target = self._resolve_path(to_path)
        if not source.exists():
            raise FileNotFoundError(from_path)
        source.rename(target)
        return {"ok": True, "path": self._relative_path(target), "from": from_path, "to": to_path}

    async def mkdir(self, path: str) -> dict:
        target = self._resolve_path(path)
        target.mkdir(parents=True, exist_ok=False)
        return {"ok": True, "path": self._relative_path(target)}

    async def search(self, *_args: Any, **_kwargs: Any) -> dict:
        raise NotImplementedError("Obsidian not running -- search requires the plugin")

    async def graph(self, *_args: Any, **_kwargs: Any) -> dict:
        raise NotImplementedError("Obsidian not running -- graph requires the plugin")

    async def get_metadata(self, *_args: Any, **_kwargs: Any) -> dict:
        raise NotImplementedError("Obsidian not running -- getMetadata requires the plugin")

    async def search_by_tag(self, *_args: Any, **_kwargs: Any) -> list[str]:
        raise NotImplementedError("Obsidian not running -- searchByTag requires the plugin")

    async def search_by_frontmatter(self, *_args: Any, **_kwargs: Any) -> list[dict]:
        raise NotImplementedError("Obsidian not running -- searchByFrontmatter requires the plugin")

    async def backlinks(self, *_args: Any, **_kwargs: Any) -> list[dict]:
        raise NotImplementedError("Obsidian not running -- backlinks requires the plugin")

    async def lint(self, *_args: Any, **_kwargs: Any) -> dict:
        raise NotImplementedError("Obsidian not running -- lint requires the plugin")

    async def batch(self, *_args: Any, **_kwargs: Any) -> dict:
        raise NotImplementedError("Obsidian not running -- batch requires the plugin")

    async def init(self, *_args: Any, **_kwargs: Any) -> dict:
        raise NotImplementedError("Obsidian not running -- init requires the plugin")

    async def wake_up(self, *_args: Any, **_kwargs: Any) -> dict:
        raise NotImplementedError("Obsidian not running -- wakeUp requires the plugin")

    async def check_duplicate(self, *_args: Any, **_kwargs: Any) -> dict:
        raise NotImplementedError("Obsidian not running -- checkDuplicate requires the plugin")

    async def get_taxonomy(self, *_args: Any, **_kwargs: Any) -> dict:
        raise NotImplementedError("Obsidian not running -- getTaxonomy requires the plugin")


class VaultBridge:
    def __init__(
        self,
        url: str,
        token: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        vault_path: str | Path | None = None,
    ):
        self._url = url
        self._token = token
        self._timeout = timeout
        self._vault_path = (
            Path(vault_path).expanduser().resolve() if vault_path is not None else None
        )
        self._ws: Any = None
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._listener: asyncio.Task | None = None
        self._closed = False
        self._event_handlers: dict[str, list[Callable]] = {}
        self._fallback: _FilesystemFallback | None = None
        self._sticky_subscriptions: list[str] = []
        self._reconnecting: bool = False

    @classmethod
    def from_discovery(cls, *, timeout: float = DEFAULT_TIMEOUT) -> VaultBridge:
        if not DISCOVERY_FILE.exists():
            raise FileNotFoundError(f"No discovery file: {DISCOVERY_FILE}")
        try:
            info = json.loads(DISCOVERY_FILE.read_text("utf-8"))
            return cls(
                url=f"ws://127.0.0.1:{info['port']}",
                token=info["token"],
                timeout=timeout,
                vault_path=info.get("vault"),
            )
        except (KeyError, json.JSONDecodeError) as e:
            raise ValueError(f"Invalid discovery file {DISCOVERY_FILE}: {e}") from e

    async def connect(self) -> dict:
        try:
            import websockets  # type: ignore
        except ImportError:
            raise ImportError("pip install websockets")
        self._closed = False
        try:
            self._ws = await websockets.connect(
                self._url, ping_interval=20, ping_timeout=10
            )
        except Exception as exc:
            if self._should_use_filesystem_fallback(exc, websockets):
                vault_path = self._require_vault_path()
                self._ws = None
                self._fallback = _FilesystemFallback(vault_path)
                LOGGER.warning(
                    "Obsidian not running -- falling back to filesystem mode at %s (%s)",
                    vault_path,
                    exc,
                )
                return {
                    "ok": True,
                    "mode": "filesystem",
                    "note": "Obsidian not running -- limited operations available",
                }
            raise
        self._fallback = None
        self._listener = asyncio.create_task(self._listen())
        return await self.call("authenticate", {"token": self._token})

    async def close(self) -> None:
        self._closed = True
        if self._listener:
            self._listener.cancel()
            self._listener = None
        if self._ws:
            await self._ws.close()
            self._ws = None

    def is_filesystem_mode(self) -> bool:
        return self._fallback is not None

    async def connect_with_retry(self, max_attempts: int = 6) -> dict:
        """Connect with exponential backoff; fall back to filesystem when exhausted.

        Backoff schedule: 1s, 2s, 4s, 8s, 16s, 30s (capped at 30 for later attempts).
        If all attempts raise AND vault_path is set, returns a filesystem-mode result
        (same shape as connect() fallback). Otherwise re-raises the last exception.

        NOTE: connect() itself still falls back IMMEDIATELY on a single failure --
        that's the dreamtime-cron contract (Gap 3). Use this method only when the
        caller actually wants to wait for a flaky server to come back (long-lived
        clients, reconnect loops).
        """
        if max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        delays = [1, 2, 4, 8, 16, 30]
        last_exc: Exception | None = None
        for attempt in range(max_attempts):
            try:
                return await self.connect()
            except Exception as exc:
                last_exc = exc
                if attempt == max_attempts - 1:
                    break
                delay = delays[min(attempt, len(delays) - 1)]
                LOGGER.warning(
                    "connect attempt %d/%d failed (%s); retrying in %ds",
                    attempt + 1,
                    max_attempts,
                    exc,
                    delay,
                )
                await asyncio.sleep(delay)

        # Exhausted. Fall back to filesystem if we can; else re-raise.
        if self._vault_path is not None:
            self._ws = None
            self._fallback = _FilesystemFallback(self._vault_path)
            LOGGER.warning(
                "connect_with_retry exhausted after %d attempts -- falling back to "
                "filesystem mode at %s",
                max_attempts,
                self._vault_path,
            )
            return {
                "ok": True,
                "mode": "filesystem",
                "note": "Obsidian not running -- limited operations available",
            }
        assert last_exc is not None  # loop guarantees this
        raise last_exc

    async def _reconnect_loop(self) -> None:
        """Background reconnect on unintentional WS drop.

        Triggered by _listen() when the socket closes without an explicit close()
        call. Runs connect_with_retry(), replays sticky subscriptions, and exits.
        In-flight calls have already been failed by _listen() before we get here
        (friction #2 decision: no id survives reconnect, caller retries).
        """
        if self._reconnecting:
            return
        self._reconnecting = True
        try:
            LOGGER.warning("WebSocket dropped -- reconnecting")
            result = await self.connect_with_retry()
            if result.get("mode") == "filesystem":
                return  # connect_with_retry already logged the fallback
            if self._sticky_subscriptions:
                try:
                    await self.call(
                        "events.subscribe",
                        {"patterns": list(self._sticky_subscriptions)},
                    )
                    LOGGER.info(
                        "replayed %d sticky subscriptions after reconnect",
                        len(self._sticky_subscriptions),
                    )
                except Exception as exc:
                    LOGGER.error("sticky-subscription replay failed: %s", exc)
        finally:
            self._reconnecting = False

    async def call(self, method: str, params: dict | None = None) -> Any:
        if self._closed or self._ws is None:
            raise ConnectionError("Not connected")
        self._id += 1
        mid = self._id
        msg = {"jsonrpc": "2.0", "method": method, "id": mid, "params": params or {}}
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[mid] = fut
        await self._ws.send(json.dumps(msg))
        try:
            return await asyncio.wait_for(fut, timeout=self._timeout)
        except asyncio.TimeoutError:
            self._pending.pop(mid, None)
            raise TimeoutError(f"{method} timed out after {self._timeout}s")

    async def _listen(self) -> None:
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                mid = msg.get("id")
                if mid is not None and mid in self._pending:
                    fut = self._pending.pop(mid)
                    if "error" in msg:
                        e = msg["error"]
                        fut.set_exception(
                            VaultBridgeError(e["code"], e["message"], e.get("data"))
                        )
                    else:
                        fut.set_result(msg.get("result"))
                elif "method" in msg and "id" not in msg:
                    method = msg["method"]
                    params = msg.get("params", {})
                    for handler in self._event_handlers.get(method, []):
                        try:
                            handler(params)
                        except Exception:
                            traceback.print_exc()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            # Fail all pending with a reconnect-hint error (friction #2 decision:
            # caller-supplied ids can't survive reconnect, so we drain immediately
            # and let the caller retry).
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(ConnectionError(f"WebSocket closed: {exc}"))
            self._pending.clear()

            intentional = self._closed
            self._ws = None
            if intentional or self._reconnecting:
                # Caller invoked close(), or another reconnect is already in flight.
                self._closed = True
                return
            # Unintentional drop (NAT timeout, server restart, suspended laptop,
            # ConnectionClosedError). Kick off background reconnect.
            asyncio.create_task(self._reconnect_loop())

    # -- events (Phase 4 ready) ------------------------------------------

    def on(self, event: str, callback: Callable) -> None:
        self._event_handlers.setdefault(event, []).append(callback)

    def off(self, event: str, callback: Callable | None = None) -> None:
        if callback is None:
            self._event_handlers.pop(event, None)
        elif event in self._event_handlers:
            self._event_handlers[event] = [
                h for h in self._event_handlers[event] if h is not callback
            ]

    # -- read-only -------------------------------------------------------

    async def read(self, path: str) -> str:
        if self._fallback:
            return await self._fallback.read(path)
        r = await self.call("vault.read", {"path": path})
        if not isinstance(r, dict):
            raise VaultBridgeError(
                -32603,
                f"malformed read response: expected dict, got {type(r).__name__}: {r!r}",
            )
        if "content" not in r:
            raise VaultBridgeError(
                -32603,
                f"malformed read response: missing 'content' key: {r!r}",
            )
        if not isinstance(r["content"], str):
            raise VaultBridgeError(
                -32603,
                f"malformed read response: 'content' is {type(r['content']).__name__}, expected str: {r!r}",
            )
        return r["content"]

    async def stat(self, path: str) -> dict:
        if self._fallback:
            return await self._fallback.stat(path)
        return await self.call("vault.stat", {"path": path})

    async def list(self, path: str = "") -> dict:
        if self._fallback:
            return await self._fallback.list(path)
        return await self.call("vault.list", {"path": path})

    async def exists(self, path: str) -> bool:
        if self._fallback:
            return await self._fallback.exists(path)
        r = await self.call("vault.exists", {"path": path})
        return _require_response_shape("exists", r, "exists", bool)

    # -- write (dry-run gated server-side) --------------------------------

    async def create(self, path: str, content: str = "", *, dry_run: bool | None = None) -> dict:
        if self._fallback:
            if dry_run is not None:
                raise NotImplementedError("Obsidian not running -- dry-run requires the plugin")
            return await self._fallback.create(path, content)
        p: dict[str, Any] = {"path": path, "content": content}
        if dry_run is not None:
            p["dryRun"] = dry_run
        return await self.call("vault.create", p)

    async def modify(self, path: str, content: str, *, dry_run: bool | None = None) -> dict:
        if self._fallback:
            if dry_run is not None:
                raise NotImplementedError("Obsidian not running -- dry-run requires the plugin")
            return await self._fallback.modify(path, content)
        p: dict[str, Any] = {"path": path, "content": content}
        if dry_run is not None:
            p["dryRun"] = dry_run
        return await self.call("vault.modify", p)

    async def append(self, path: str, content: str, *, dry_run: bool | None = None) -> dict:
        if self._fallback:
            if dry_run is not None:
                raise NotImplementedError("Obsidian not running -- dry-run requires the plugin")
            return await self._fallback.append(path, content)
        p: dict[str, Any] = {"path": path, "content": content}
        if dry_run is not None:
            p["dryRun"] = dry_run
        return await self.call("vault.append", p)

    async def delete(self, path: str, *, force: bool = False, dry_run: bool | None = None) -> dict:
        if self._fallback:
            if dry_run is not None or force:
                raise NotImplementedError("Obsidian not running -- delete options require the plugin")
            return await self._fallback.delete(path)
        p: dict[str, Any] = {"path": path, "force": force}
        if dry_run is not None:
            p["dryRun"] = dry_run
        return await self.call("vault.delete", p)

    async def rename(self, from_path: str, to_path: str, *, dry_run: bool | None = None) -> dict:
        if self._fallback:
            if dry_run is not None:
                raise NotImplementedError("Obsidian not running -- dry-run requires the plugin")
            return await self._fallback.rename(from_path, to_path)
        p: dict[str, Any] = {"from": from_path, "to": to_path}
        if dry_run is not None:
            p["dryRun"] = dry_run
        return await self.call("vault.rename", p)

    async def mkdir(self, path: str, *, dry_run: bool | None = None) -> dict:
        if self._fallback:
            if dry_run is not None:
                raise NotImplementedError("Obsidian not running -- dry-run requires the plugin")
            return await self._fallback.mkdir(path)
        p: dict[str, Any] = {"path": path}
        if dry_run is not None:
            p["dryRun"] = dry_run
        return await self.call("vault.mkdir", p)

    # -- Phase 3: search, graph, batch -----------------------------------

    async def search(
        self,
        query: str,
        *,
        regex: bool = False,
        case_sensitive: bool = False,
        max_results: int = 50,
        glob: str | None = None,
        context: int = 1,
    ) -> dict:
        p: dict[str, Any] = {"query": query, "regex": regex, "caseSensitive": case_sensitive, "maxResults": max_results, "context": context}
        if glob is not None:
            p["glob"] = glob
        return await self.call("vault.search", p)

    async def get_metadata(self, path: str) -> dict:
        return await self.call("vault.getMetadata", {"path": path})

    async def search_by_tag(self, tag: str) -> list[str]:
        r = await self.call("vault.searchByTag", {"tag": tag})
        return _require_response_shape("searchByTag", r, "files", list)

    async def search_by_frontmatter(self, key: str, value: Any = None) -> list[dict]:
        p: dict[str, Any] = {"key": key}
        if value is not None:
            p["value"] = value
        r = await self.call("vault.searchByFrontmatter", p)
        return r["files"]

    async def graph(self, type: str = "both") -> dict:
        return await self.call("vault.graph", {"type": type})

    async def backlinks(self, path: str) -> list[dict]:
        r = await self.call("vault.backlinks", {"path": path})
        return _require_response_shape("backlinks", r, "backlinks", list)

    async def lint(self, *, required_frontmatter: list[str] | None = None) -> dict:
        p: dict[str, Any] = {}
        if required_frontmatter:
            p["requiredFrontmatter"] = required_frontmatter
        return await self.call("vault.lint", p)

    async def batch(self, operations: list[dict], *, dry_run: bool | None = None) -> dict:
        p: dict[str, Any] = {"operations": operations}
        if dry_run is not None:
            p["dryRun"] = dry_run
        return await self.call("vault.batch", p)

    async def capabilities(self) -> list[str]:
        r = await self.call("listCapabilities")
        return _require_response_shape("listCapabilities", r, "methods", list)

    # -- subscriptions (Phase 4) -----------------------------------------

    async def subscribe(self, events: list[str]) -> dict:
        result = await self.call("events.subscribe", {"patterns": events})
        # Sticky: remember so _reconnect_loop can replay after reconnect.
        for pattern in events:
            if pattern not in self._sticky_subscriptions:
                self._sticky_subscriptions.append(pattern)
        return result

    async def unsubscribe(self, events: list[str]) -> dict:
        result = await self.call("events.unsubscribe", {"patterns": events})
        drop = set(events)
        self._sticky_subscriptions = [
            pattern for pattern in self._sticky_subscriptions if pattern not in drop
        ]
        return result

    async def list_events(self) -> dict:
        return await self.call("events.list")

    # -- context manager --------------------------------------------------

    async def __aenter__(self) -> VaultBridge:
        await self.connect()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    def _require_vault_path(self) -> Path:
        if self._vault_path is None:
            raise RuntimeError(
                "Filesystem fallback requires vault_path. Pass vault_path=... to VaultBridge "
                "or include a 'vault' field in ~/.obsidian-ws-port."
            )
        return self._vault_path

    def _should_use_filesystem_fallback(self, exc: Exception, websockets_module: Any) -> bool:
        if isinstance(exc, (OSError, ConnectionRefusedError)):
            return True

        websocket_errors: list[type[BaseException]] = []
        exceptions_mod = getattr(websockets_module, "exceptions", None)
        if exceptions_mod is not None:
            for name in ("WebSocketException", "InvalidHandshake", "InvalidStatus", "SecurityError"):
                err_type = getattr(exceptions_mod, name, None)
                if isinstance(err_type, type):
                    websocket_errors.append(err_type)
        return bool(websocket_errors) and isinstance(exc, tuple(websocket_errors))
