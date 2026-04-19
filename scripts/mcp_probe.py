#!/usr/bin/env python
"""mcp_probe.py -- deeper probe: vault.list, vault.search variants,
vault.searchByTag. Prints evidence about what the server can actually see.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path("D:/projects/obsidian-llm-wiki")
SERVER = ["node", "mcp-server/dist/index.js"]


def rpc(proc, rid, method, params):
    msg = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    return json.loads(line)


def notify(proc, method, params):
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}) + "\n")
    proc.stdin.flush()


def call_tool(proc, rid, name, arguments):
    resp = rpc(proc, rid, "tools/call", {"name": name, "arguments": arguments})
    if "error" in resp:
        return {"error": resp["error"]}
    content = resp.get("result", {}).get("content", [])
    if content and isinstance(content, list) and content[0].get("type") == "text":
        try:
            return json.loads(content[0]["text"])
        except json.JSONDecodeError:
            return content[0]["text"]
    return resp.get("result")


def main() -> int:
    proc = subprocess.Popen(
        SERVER, cwd=ROOT,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", bufsize=1,
    )
    try:
        rpc(proc, 1, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "probe", "version": "0.1"},
        })
        notify(proc, "notifications/initialized", {})

        # 1. vault.list top-level
        print("\n=== vault.list '.' ===")
        result = call_tool(proc, 2, "vault.list", {"path": "."})
        print(json.dumps(result, ensure_ascii=False, indent=2)[:1500])

        # 2. vault.list on 03-Trading (should contain P_risk notes)
        print("\n=== vault.list '03-Trading' ===")
        result = call_tool(proc, 3, "vault.list", {"path": "03-Trading"})
        s = json.dumps(result, ensure_ascii=False, indent=2)
        print(s[:1500])
        if len(s) > 1500:
            print(f"    ... +{len(s)-1500} chars truncated")

        # 3. vault.search with different queries
        for q in ["P_risk", "p_risk", "risk", "trading"]:
            print(f"\n=== vault.search {q!r} ===")
            result = call_tool(proc, 10 + len(q), "vault.search", {"query": q, "limit": 3})
            total = result.get("totalMatches", "?") if isinstance(result, dict) else "?"
            print(f"totalMatches={total}")
            if isinstance(result, dict) and result.get("results"):
                for r in result["results"][:3]:
                    print(f"  - {r.get('path', r)}")

        # 4. vault.searchByTag
        print("\n=== vault.searchByTag 'trading' ===")
        result = call_tool(proc, 20, "vault.searchByTag", {"tag": "trading"})
        s = json.dumps(result, ensure_ascii=False, indent=2)
        print(s[:800])

        # 5. vault.stat on a file we know exists
        print("\n=== vault.stat on E:/knowledge root ===")
        result = call_tool(proc, 30, "vault.stat", {"path": "."})
        print(json.dumps(result, ensure_ascii=False, indent=2)[:600])

        return 0
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        err = proc.stderr.read()
        if err.strip():
            print("\n--- server stderr ---", file=sys.stderr)
            print(err[:2000], file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
