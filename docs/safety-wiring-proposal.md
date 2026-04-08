# Safety Gate Wiring Proposal

## Summary

The modules vault_safe_paths.py and vault_write_validator.py are orphaned because the assumed Python write path does not exist in mcp_server.py. That file is a pure pass-through which forwards every MCP tool call over WebSocket to the TypeScript BridgeApp in src/handlers.ts. Real writes live in TS (src/bridge.ts methods create/modify/append). The safety gates must be wired at TWO layers: (1) the Python MCP layer as a pre-flight client-side gate (defense-in-depth, fails fast before RPC), and (2) the TypeScript handler layer as the authoritative gate (the only place that actually touches the vault). Option (i) port to TS and keep Python checks as a fast-reject mirror is the right call because the TS layer is the real trust boundary and cannot safely delegate to a subprocess that may not be running.

## Architecture Decision

Option (i): Port both modules to TypeScript, keep Python copies as a pre-flight mirror.

Why: Option (ii) subprocess call adds 50-300ms per write and a new failure mode (Python missing) that breaks a plugin used headless. Option (iii) expose-an-unsafe-API and route-through-Python inverts the trust boundary. The plugin would trust any WebSocket client claiming to be the sanitizer, and the authoritative write in BridgeApp.create would run unchecked. Option (i) costs ~120 lines of TS (bridge-safe-paths.ts plus bridge-write-validator.ts) and duplicates two frozensets and five regexes, which is cheap because the blocklists evolve slowly and the regexes are identical across languages. The Python copies stay as a client-side fast-fail so MCP clients get a sensible error before burning a WebSocket round trip.

## Python Patches (mcp_server.py)

### Patch 1: import

File: mcp_server.py, top of file, after line 26 (from vault_bridge import VaultBridge)

    from vault_safe_paths import is_safe_to_write
    from vault_write_validator import validate_vault_write, ValidationResult

### Patch 2: gate the write-capable tools in call_tool

File: mcp_server.py, function call_tool (line 272).
Strategy: insert a gate block between line 278 (params = transform(arguments)) and line 280 (try:). The gate runs for vault_create, vault_modify, vault_append. The tools vault_delete and vault_rename are path-only checks (no content), so they get the path gate but skip the validator.

Before (lines 272-286):

    @app.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        if name not in TOOL_MAP:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]

        rpc_method, transform = TOOL_MAP[name]
        params = transform(arguments)

        try:
            vb = await get_bridge()
            result = await vb.call(rpc_method, params)
            text = json.dumps(result, indent=2, ensure_ascii=False) if isinstance(result, (dict, list)) else str(result)
            return [TextContent(type="text", text=text)]
        except Exception as e:
            return [TextContent(type="text", text=f"Error: {e}")]

After:

    WRITE_TOOLS_PATH_GATED = {"vault_create", "vault_modify", "vault_append", "vault_delete", "vault_rename"}
    WRITE_TOOLS_CONTENT_GATED = {"vault_create", "vault_modify", "vault_append"}


    async def _preflight_write_gate(name: str, params: dict) -> TextContent | None:
        # Client-side safety mirror of the TS authoritative gate.
        # Returns a TextContent error to abort, or None to proceed.

        # Path gate (also covers rename to/from and delete path)
        if name in WRITE_TOOLS_PATH_GATED:
            paths_to_check = []
            if name == "vault_rename":
                paths_to_check.append(params.get("to", ""))
                paths_to_check.append(params.get("from", ""))
            else:
                paths_to_check.append(params.get("path", ""))
            for pth in paths_to_check:
                if not pth:
                    continue
                if not is_safe_to_write(pth, allow_canvas=False):
                    return TextContent(
                        type="text",
                        text=json.dumps({
                            "error": "safety_gate_rejected",
                            "reason": "protected_path",
                            "path": pth,
                            "hint": "path matches blocked extension, directory, or traversal pattern",
                        }, ensure_ascii=False),
                    )

        # Content gate for create/modify/append
        if name in WRITE_TOOLS_CONTENT_GATED:
            content = params.get("content", "")
            if not isinstance(content, str):
                return None  # let server reject
            original = None
            if name in ("vault_modify", "vault_append"):
                try:
                    vb = await get_bridge()
                    read_result = await vb.call("vault.read", {"path": params["path"]})
                    original = read_result.get("content") if isinstance(read_result, dict) else None
                    if name == "vault_append" and isinstance(original, str):
                        content = original + content  # validate combined content
                except Exception:
                    original = None  # read failed, let server handle

            result = validate_vault_write(
                new_content=content,
                original_content=original,
                require_frontmatter=False,
            )
            if not result.is_valid:
                return TextContent(
                    type="text",
                    text=json.dumps({
                        "error": "safety_gate_rejected",
                        "reason": "content_validation_failed",
                        "errors": result.errors,
                        "warnings": result.warnings,
                    }, ensure_ascii=False),
                )
        return None


    @app.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        if name not in TOOL_MAP:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]

        rpc_method, transform = TOOL_MAP[name]
        params = transform(arguments)

        # Safety gate: fail fast before burning an RPC round-trip.
        # TS handler is still the authoritative gate; this is a mirror.
        gate_error = await _preflight_write_gate(name, params)
        if gate_error is not None:
            return [gate_error]

        try:
            vb = await get_bridge()
            result = await vb.call(rpc_method, params)
            text = json.dumps(result, indent=2, ensure_ascii=False) if isinstance(result, (dict, list)) else str(result)
            return [TextContent(type="text", text=text)]
        except Exception as e:
            return [TextContent(type="text", text=f"Error: {e}")]

### Patch 3: gate vault_batch sub-operations

File: mcp_server.py, same call_tool function.
Reason: vault_batch forwards an array of operations to the TS vault.batch handler which dispatches them individually. The preflight must walk the operations array and run the same gate on each write op. Without this, an LLM can bypass the gate by wrapping a write in a batch.

Add inside _preflight_write_gate before the final return None:

    if name == "vault_batch":
        ops = params.get("operations", [])
        if not isinstance(ops, list):
            return None
        reverse_map = {
            "vault.create": "vault_create",
            "vault.modify": "vault_modify",
            "vault.append": "vault_append",
            "vault.delete": "vault_delete",
            "vault.rename": "vault_rename",
        }
        for i, op in enumerate(ops):
            if not isinstance(op, dict):
                continue
            sub_method = op.get("method", "")
            sub_params = op.get("params", {}) or {}
            sub_tool = reverse_map.get(sub_method)
            if sub_tool is None:
                continue
            err = await _preflight_write_gate(sub_tool, sub_params)
            if err is not None:
                return TextContent(
                    type="text",
                    text=json.dumps({
                        "error": "safety_gate_rejected",
                        "reason": "batch_sub_operation_rejected",
                        "index": i,
                        "method": sub_method,
                        "detail": json.loads(err.text),
                    }, ensure_ascii=False),
                )

Note: handle vault_batch explicitly so that read-only sub-ops in a batch are NOT gated.

## TypeScript Patches (authoritative gate)

These are the mandatory port of the Python modules. They must land BEFORE any write reaches BridgeApp.create/modify/append. File shapes only. Another agent writes the code.

### File: src/bridge-safe-paths.ts (new)

Mirror of vault_safe_paths.py. Exports isSafeToWrite(path: string, opts?: { allowCanvas?: boolean }): boolean and the two frozensets BLOCKED_EXTENSIONS, BLOCKED_DIRECTORIES as ReadonlySet<string>. Three internal helpers: isBlockedExtension, isBlockedDirectory, hasPathTraversal. Do NOT import the Node path module. The plugin runs in Electron renderer and path.sep is platform-dependent. Use manual split on forward slash after normalizing backslashes. Match the Python logic byte-for-byte including the Windows drive-letter check (path at index 1 equals colon).

### File: src/bridge-write-validator.ts (new)

Mirror of vault_write_validator.py. Exports validateVaultWrite(newContent: string, originalContent: string | null, opts?: { requireFrontmatter?: boolean }): ValidationResult where ValidationResult = { isValid: boolean; errors: string[]; warnings: string[] }. Five internal check functions with regex identical to the Python originals.

### File: src/handlers.ts (modify)

Wire the gates into three handlers. Shape:

In vault.create (line 86):
- After const content = ..., before isDryRun check: call isSafeToWrite(path). If false, throw { code: RPC_SAFETY_PATH_BLOCKED, message, data: { path } }.
- Then call validateVaultWrite(content, null). If not valid, throw { code: RPC_SAFETY_CONTENT_REJECTED, message, data: { errors, warnings } }.

In vault.modify (line 95):
- After const content = requireString(...), call isSafeToWrite(path).
- Call await bridge.read(path) to get original (wrap in try -- if read fails, pass null).
- Call validateVaultWrite(content, original).

In vault.append (line 104):
- After path check, call isSafeToWrite(path).
- Read original, compute newContent = original + content, validate newContent against original.

In vault.delete (line 113) and vault.rename (line 122):
- Path gate only, no content check. vault.rename must check BOTH from and to.

### File: src/protocol.ts (modify)

Add two JSON-RPC error codes:

    export const RPC_SAFETY_PATH_BLOCKED = -32010;
    export const RPC_SAFETY_CONTENT_REJECTED = -32011;

### Settings wiring (src/types.ts and settings tab)

Add VaultBridgeSettings.safety:

    safety: {
      enabled: boolean;        // default true
      allowCanvas: boolean;    // default false
      requireFrontmatter: "never" | "new-files-only" | "always";  // default new-files-only
    }

## Decision Rationale (the 5 sub-questions)

### (a) Python gate placement

In mcp_server.py call_tool, a single _preflight_write_gate function called once per tool invocation (patches 2 and 3 above). NOT in vault_bridge.py. That is the transport layer, not the policy layer. Keeping the gate in mcp_server.py isolates MCP-facing policy from the raw RPC client so other Python consumers of VaultBridge (scripts, kb_meta.py) are unaffected.

### (b) TS duplication dilemma: pick Option (i)

Picked Option (i). The TS plugin is the only process guaranteed to be running when a write happens. Headless dreamtime writes the vault at 03:00 with no Python MCP server attached. Option (ii) breaks headless use. Option (iii) gives the plugin no defense against buggy or malicious clients bypassing the Python layer. Duplication cost is two ~80-line files with regexes that change maybe twice a year. CLAUDE.md explicitly says plugin write operations must have dry-run mode. The plugin owns vault safety.

### (c) require_frontmatter default

Default FALSE at the validator call site, but expose a three-mode setting:
- never (never require): useful for draft scratchpads
- new-files-only (default): vault.create requires frontmatter, vault.modify/append only check that existing frontmatter is preserved
- always: strict mode for curated KB vaults

Rationale: vault.init in handlers.ts lines 258-265 already generates frontmatter for every scaffolded file, so the new files have frontmatter invariant is already enforced by convention. Daily notes created via Templater also land with frontmatter. Appending to Log.md is the only common case where the delta has no frontmatter, and the preservation check (original had frontmatter therefore new must too) already handles it because vault_append validates the combined post-append content, not just the delta.

### (d) Canvas handling

Hard-block by default, expose setting to override. Reasoning: canvas files are JSON-with-magic that Obsidian Canvas parses strictly. A single LLM-generated canvas write has very high probability of corrupting layout, connections, or node IDs. But there is a vault-mind connect use case where a Canvas-aware writer could legitimately generate canvas content. Exposing safety.allowCanvas (default false) matches the is_safe_to_write(allow_canvas=False) API already in the Python module. The default blocks; the setting is a conscious opt-in that documents the risk in the settings UI.

### (e) Error propagation via JSON-RPC 2.0

Two new error codes (-32010, -32011) in the application-defined range (-32099 to -32000 per JSON-RPC 2.0 spec). Shape for path rejection:

    {
      "jsonrpc": "2.0",
      "id": 42,
      "error": {
        "code": -32010,
        "message": "Safety gate rejected write: protected path",
        "data": {
          "gate": "path",
          "reason": "blocked_directory",
          "path": ".obsidian/config.json",
          "hint": "Path segment .obsidian is in BLOCKED_DIRECTORIES"
        }
      }
    }

For content validation failures:

    {
      "jsonrpc": "2.0",
      "id": 43,
      "error": {
        "code": -32011,
        "message": "Safety gate rejected write: content validation failed (2 errors)",
        "data": {
          "gate": "content",
          "errors": [
            "wikilink bracket mismatch: 3 open vs 2 close",
            "URLs dropped: [https://example.com/paper.pdf]"
          ],
          "warnings": [
            "heading skip at #4: h2 -> h4 (Details)"
          ]
        }
      }
    }

The Python MCP wrapper (call_tool) converts these into a structured TextContent JSON payload (NOT a plain string) so LLM agents can pattern-match error == safety_gate_rejected and trigger retry-with-fix logic. This is why the preflight returns json.dumps(...) instead of a plain error string.

## Blast Radius per Patch

| Patch | Runtime Behaviors Changed | Scope |
|-------|---------------------------|-------|
| Python patch 1 (import) | Zero. Import-only. | Negligible |
| Python patch 2 (call_tool gate for single ops) | 5 tools reject on path violations; 3 tools reject on content violations. Adds 1 RPC read round-trip for modify/append to fetch original. | Medium: changes success/failure surface of write tools, adds ~50ms latency for modify/append |
| Python patch 3 (batch recursion) | vault_batch rejects entire batch on first safety violation. | Medium: default is fail-fast-whole-batch |
| TS bridge-safe-paths.ts (new) | Zero until wired into handlers. | Nil |
| TS bridge-write-validator.ts (new) | Zero until wired into handlers. | Nil |
| TS handlers.ts (wire gates) | Every WebSocket write (including non-MCP clients, any direct plugin internal calls) passes through the gate. Adds 1 bridge.read per modify/append for original content. | HIGH: authoritative layer, affects every write source |
| TS protocol.ts (new codes) | Clients that hard-code error code enums need updating. | Low |
| Settings wiring | New default-on safety adds user-visible setting. | Low |

## Open Questions for User

1. Batch behavior: On the first safety violation in vault_batch, should we (a) fail the whole batch (current proposal, fail-fast), (b) skip the bad op and continue, or (c) dry-run the whole batch if any op would fail? My vote: (a), because partial batch application leaves the vault in an intermediate state that is harder to reason about.

2. Frontmatter mode default: Is new-files-only the right default, or should curated KB vaults default to always and scratchpad vaults default to never? This might belong as a per-vault setting in kb.yaml, not plugin-global.

3. Canvas override: Should safety.allowCanvas be global, per-folder, or per-request (LLM passes allowCanvas:true in RPC params, server checks both setting AND request flag)? My vote: global setting OR per-request, but require BOTH: belt and suspenders.

4. Validator warning policy: Heading skips are currently warnings (non-blocking). Should an MCP client be able to promote warnings to errors via a per-call strict:true param? Relevant for the compile workflow in CLAUDE.md where the sonnet subagent should be held to higher standards than a raw dreamtime dump.

5. TS test coverage: Should porting include copying tests/test_vault_safe_paths.py and tests/test_vault_write_validator.py into a TS vitest/jest suite to prove the TS port is byte-compatible with the Python reference? Strongly recommended but out of scope for the wire-it-up task: separate port-tests task.

6. Settings migration: The new safety settings block needs a migration for existing users with older data.json. Default to safe values if the key is missing.

## Source bugs / concerning patterns noticed

- handlers.ts line 196 (vault.batch): op.method?.startsWith uses optional chaining which is fine, but if op.method is a non-string (number, object), startsWith throws TypeError instead of the intended JSON-RPC error. Add an explicit typeof op.method === string guard.

- handlers.ts line 202 (vault.batch): const params = { ...(op.params ?? {}) }. If op.params is a non-object (string, number), spread silently produces an empty object which then gets forwarded. Not dangerous but masks malformed client calls.

- mcp_server.py line 285: the generic except clause collapses everything to f"Error: {e}". This loses the structured JSON-RPC error code from VaultBridgeError. Downstream tooling that wants to distinguish RPC_FILE_NOT_FOUND from RPC_INVALID_PARAMS has no way to. Worth raising as a separate ticket.

- vault_bridge.py line 130 (VaultBridge.read): returns r["content"] without shape-checking. If the server ever returns a non-dict result for vault.read, this raises KeyError. The preflight proposal catches this in try/except and falls back to original=None, but the underlying client is fragile.

- vault_write_validator.py line 185: the warning message template has an f-string bug. The string literal is consider inserting an h{prev_level + 1}. This is a PLAIN string, NOT an f-string, so it emits literal text h{prev_level + 1} instead of the computed level. Needs fixing as a drive-by during wiring, or as a separate fix.

- vault_safe_paths.py line 152: _has_path_traversal treats bare "." segments as traversal, so paths like ./notes/idea.md are rejected. The TS handler in handlers.ts lines 19-22 already normalizes these out, so the Python gate is STRICTER than the TS handler on this one point. Pick one semantic and align both during the port.
