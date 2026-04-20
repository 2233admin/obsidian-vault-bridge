"""Async Python client for Obsidian Vault Bridge WebSocket server."""

from __future__ import annotations

import asyncio
import json
import traceback
from pathlib import Path
from typing import Any, Callable

DISCOVERY_FILE = Path.home() / ".obsidian-ws-port"
DEFAULT_TIMEOUT = 30.0


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


class VaultBridge:
    def __init__(self, url: str, token: str, *, timeout: float = DEFAULT_TIMEOUT):
        self._url = url
        self._token = token
        self._timeout = timeout
        self._ws: Any = None
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._listener: asyncio.Task | None = None
        self._closed = False
        self._event_handlers: dict[str, list[Callable]] = {}

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
            )
        except (KeyError, json.JSONDecodeError) as e:
            raise ValueError(f"Invalid discovery file {DISCOVERY_FILE}: {e}") from e

    async def connect(self) -> dict:
        try:
            import websockets  # type: ignore
        except ImportError:
            raise ImportError("pip install websockets")
        self._closed = False
        self._ws = await websockets.connect(self._url)
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
            self._closed = True
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(ConnectionError(f"WebSocket closed: {exc}"))
            self._pending.clear()

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
        return await self.call("vault.stat", {"path": path})

    async def list(self, path: str = "") -> dict:
        return await self.call("vault.list", {"path": path})

    async def exists(self, path: str) -> bool:
        r = await self.call("vault.exists", {"path": path})
        return _require_response_shape("exists", r, "exists", bool)

    # -- write (dry-run gated server-side) --------------------------------

    async def create(self, path: str, content: str = "", *, dry_run: bool | None = None) -> dict:
        p: dict[str, Any] = {"path": path, "content": content}
        if dry_run is not None:
            p["dryRun"] = dry_run
        return await self.call("vault.create", p)

    async def modify(self, path: str, content: str, *, dry_run: bool | None = None) -> dict:
        p: dict[str, Any] = {"path": path, "content": content}
        if dry_run is not None:
            p["dryRun"] = dry_run
        return await self.call("vault.modify", p)

    async def append(self, path: str, content: str, *, dry_run: bool | None = None) -> dict:
        p: dict[str, Any] = {"path": path, "content": content}
        if dry_run is not None:
            p["dryRun"] = dry_run
        return await self.call("vault.append", p)

    async def delete(self, path: str, *, force: bool = False, dry_run: bool | None = None) -> dict:
        p: dict[str, Any] = {"path": path, "force": force}
        if dry_run is not None:
            p["dryRun"] = dry_run
        return await self.call("vault.delete", p)

    async def rename(self, from_path: str, to_path: str, *, dry_run: bool | None = None) -> dict:
        p: dict[str, Any] = {"from": from_path, "to": to_path}
        if dry_run is not None:
            p["dryRun"] = dry_run
        return await self.call("vault.rename", p)

    async def mkdir(self, path: str, *, dry_run: bool | None = None) -> dict:
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
        return await self.call("events.subscribe", {"patterns": events})

    async def unsubscribe(self, events: list[str]) -> dict:
        return await self.call("events.unsubscribe", {"patterns": events})

    async def list_events(self) -> dict:
        return await self.call("events.list")

    # -- context manager --------------------------------------------------

    async def __aenter__(self) -> VaultBridge:
        await self.connect()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
