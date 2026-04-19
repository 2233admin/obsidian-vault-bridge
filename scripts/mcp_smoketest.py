#!/usr/bin/env python
"""mcp_smoketest.py -- spawn vault-mind MCP server via stdio and send
initialize + tools/list + vault.search. Prints responses, exits.

Works around a broken bash profile that exits 1 on non-tty stdin.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("D:/projects/obsidian-llm-wiki")
SERVER = ["node", "mcp-server/dist/index.js"]


def main() -> int:
    proc = subprocess.Popen(
        SERVER,
        cwd=ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,  # line-buffered
    )

    def send(method: str, params: dict | None = None, rid: int | None = None):
        msg = {"jsonrpc": "2.0", "method": method}
        if rid is not None:
            msg["id"] = rid
        if params is not None:
            msg["params"] = params
        line = json.dumps(msg) + "\n"
        proc.stdin.write(line)
        proc.stdin.flush()
        print(f"--> {method}", flush=True)

    def read_one(timeout: float = 3.0) -> dict | None:
        # Line-based read with rough timeout via Popen.stdout.readline.
        # Since we can't easily set timeout on Windows stdin read, this
        # is best-effort: if server never responds, we rely on the parent
        # timeout below.
        line = proc.stdout.readline()
        if not line:
            return None
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            print(f"<-- [non-json] {line.rstrip()}", flush=True)
            return None

    try:
        # 1. initialize
        send(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "smoketest", "version": "0.1"},
            },
            rid=1,
        )
        resp = read_one()
        if resp is None:
            print("ERROR: no response to initialize", file=sys.stderr)
            return 2
        print(f"<-- initialize result: {json.dumps(resp.get('result', resp.get('error')), ensure_ascii=False)[:500]}")

        # 2. initialized notification
        send("notifications/initialized", {})

        # 3. tools/list
        send("tools/list", {}, rid=2)
        resp = read_one()
        if resp is None:
            print("ERROR: no response to tools/list", file=sys.stderr)
            return 3
        tools = resp.get("result", {}).get("tools", [])
        print(f"<-- tools/list returned {len(tools)} tools:")
        for t in tools[:25]:
            print(f"    - {t.get('name')}: {t.get('description', '')[:80]}")
        if len(tools) > 25:
            print(f"    ... and {len(tools) - 25} more")

        # 4. vault.search (try common forms — name may be `vault.search` or `vault_search`)
        names = {t.get("name") for t in tools}
        search_tool = None
        for cand in ("vault.search", "vault_search", "search"):
            if cand in names:
                search_tool = cand
                break
        if not search_tool:
            print("WARN: no obvious search tool in list. Tools present:", sorted(names))
            return 0

        send(
            "tools/call",
            {"name": search_tool, "arguments": {"query": "P_risk", "limit": 3}},
            rid=3,
        )
        resp = read_one(timeout=10.0)
        if resp is None:
            print(f"ERROR: no response to {search_tool} call", file=sys.stderr)
            return 4
        content = resp.get("result", {}).get("content", resp.get("error"))
        print(f"<-- {search_tool} call result (first 1500 chars):")
        print(json.dumps(content, ensure_ascii=False, indent=2)[:1500])
        return 0
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        err = proc.stderr.read()
        if err:
            print("--- server stderr ---", file=sys.stderr)
            print(err[:2000], file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
