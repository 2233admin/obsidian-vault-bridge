# Decision: yaml-blocklist conflict between vault_safe_paths and vault.init

## Status

Accepted | 2026-04-08

## Context

`vault_safe_paths.py:50` (the just-committed safety module) lists `.yaml` in
`_CAVEMAN_SKIP_EXTENSIONS`, inherited from JuliusBrussee/caveman as a
"code/config files LLMs should not write" blocklist. `BLOCKED_EXTENSIONS`
(line 84) is the union of that set and `_VAULT_EXTRA_BLOCKED`, so `.yaml`
ends up in the final blocklist.

`src/handlers.ts:296-302` -- the `vault.init` scaffold -- writes a
`kb.yaml` file as part of bootstrapping a topic. This is a plugin-internal
write, not an LLM-driven write.

`docs/safety-wiring-proposal.md` (W3 deliverable) wires the safety gate
into the write path. Two readings of the proposal collide:

- Line 5: "must land BEFORE any write reaches `BridgeApp.create / modify /
  append`" -- bridge-layer wiring.
- Line 190: "In `vault.create` (line 86): After `const content = ...`,
  before `isDryRun` check" -- handler-layer wiring.

These are **different layers** with different consequences for this conflict.
The proposal does not pick one. The ambiguity IS the load-bearing question.

A second hidden fact: `vault.init` calls `bridge.create()` **directly** at
`handlers.ts:266` and `:300`, not through `server.getHandler("vault.create")`.
So if the gate is wired at the **handler layer**, `vault.init` naturally
bypasses it without needing any flag, and the `kb.yaml` conflict
**vanishes**. The conflict only exists if the gate is wired at the
bridge layer.

## Options Considered

### Option (a) -- Remove `.yaml` from `BLOCKED_EXTENSIONS`

**Pros**

- 3 LOC change, trivially reversible
- No new abstraction

**Cons**

- **Broken as stated.** Removing `.yaml` from the blocklist is not enough.
  `vault_safe_paths.py:201-203`'s allowlist fallback
  (`if suffix and suffix not in ALLOWED_VAULT_EXTENSIONS: return False`)
  still rejects `.yaml` because `ALLOWED_VAULT_EXTENSIONS` is
  `{.md, .markdown, .txt, .rst, .canvas}`. To make this option work you
  must ALSO add `.yaml` to `ALLOWED_VAULT_EXTENSIONS`. The original
  proposal author missed this.
- Even if patched, drops one layer of defense globally to solve a local
  problem.
- Future fit poor: every new internal-writer extension needs another
  whitelist entry.

### Option (b) -- Trusted internal writer flag

**Pros**

- Surgical, grep-auditable carve-out for plugin-internal scaffolds.
- Caveman blocklist remains the default-deny for LLM writes.
- Scales to the next plugin-internal writers (daily-note templates,
  frontmatter-repair, ingest copy).

**Cons**

- ~15 LOC + threads a `trusted_internal: bool = False` parameter through
  every callsite of the gate.
- Privilege bit must be guarded -- if a future LLM-routed code path
  accidentally passes `trusted_internal=True`, the gate is silent.
- Open question: does the trusted flag bypass ONLY the blocklist, or
  ALSO the allowlist fallback at line 201-203? If only the blocklist,
  `vault.init` still fails.

### Option (c) -- Change scaffold extension

**Verified collapsed.** All three candidates are in `_CAVEMAN_SKIP_EXTENSIONS`:

- `.json` -- line 50
- `.yaml` / `.yml` -- line 50
- `.toml` -- line 50

And the allowlist at line 87-91 only allows `.md`, `.markdown`, `.txt`,
`.rst`, `.canvas`. So even if an extension were not explicitly in
`BLOCKED_EXTENSIONS`, the allowlist fallback rejects unknown suffixes.

Option (c) degrades to: "use `kb.md` with YAML frontmatter and parse the
frontmatter as KB config". Tractable -- the existing `vault.init`
scaffolds are already frontmatter-ful -- but a data model change to
solve a gate problem.

### Option (d) -- Three-tier blocklist (hard / warn / allow)

**Pros**

- Architecturally clean: explicit semantics for every extension.
- Future-proof for new extensions and new writers.

**Cons**

- ~60 LOC + new config schema + 3 new predicates + new logging surface.
- Disproportionate to a single `kb.yaml` conflict.
- Violates the "no abstraction for assumed future" principle in
  `~/.claude/rules/common/anthropic-design-philosophy.md`.

## Decision

**Primary path: handler-layer wiring. The conflict vanishes.**

The safety gate lives in `src/handlers.ts` at the `vault.create`,
`vault.modify`, and `vault.append` handler entry points -- NOT at
`BridgeApp.create / modify / append` in `src/bridge.ts`. `vault.init`
already calls `bridge.create` directly and naturally bypasses the gate
without needing any privilege flag.

**Fallback: option (b) IF a future change moves the gate down to the
bridge layer.** That decision should not be taken lightly -- moving the
gate down means every existing `bridge.create` callsite must be audited
and explicitly opted out via `{ trustedInternal: true }`. Option (b) is
on the shelf for that day; today, it is not needed.

**Test invariant** (must be added when applying the safety wiring):

```ts
// tests/handlers.test.ts (or new tests/safety.test.ts)
it("vault.init scaffold is not blocked by the safety gate", async () => {
  // ... seed empty vault, call vault.init with topic 'foo' ...
  // assert kb.yaml gets created without throwing RPC_SAFETY_PATH_BLOCKED
});
```

This test catches the regression if anyone later moves the gate from
handler layer to bridge layer.

### Justification (5 sentences)

1. `vault.init` is the archetype of a plugin-internal scaffold with
   hardcoded, bounded content -- exactly the case the safety gate is
   not designed for.
2. Option (a) is broken as stated (allowlist fallback still rejects)
   and weakens defense globally to solve a local problem.
3. Option (c) collapses per the verification above and forces a data
   model change to solve a gate problem.
4. Option (d) is architecturally pure but disproportionate to a single
   conflict and violates the "no abstraction for assumed future"
   principle.
5. Handler-layer wiring is the minimum change that preserves the
   caveman blocklist as default-deny for LLM writes while leaving
   internal scaffolds untouched -- and option (b) remains on the shelf
   if the boundary needs to move down later.

## Consequences

**Unblocks:**

- Safety wiring proposal (`docs/safety-wiring-proposal.md`) can land,
  with the explicit constraint "wire at handler layer only".
- `vault.create` / `vault.modify` / `vault.append` become authoritative
  gates for LLM-driven writes.

**Breaks:** Nothing, if wired at handler layer as decided. If a future
PR moves the gate down to bridge layer, every existing `bridge.create`
callsite must be audited. The test invariant above will catch this.

**Defense surface:** Unchanged for LLM-routed writes. A documented
carve-out for plugin-internal scaffolds: scaffolds bypass the gate by
calling `bridge.*` directly instead of `server.getHandler("vault.*")`.

**Future writers** (the next 3-5 we know about):

| Writer | Layer | Routes via | Needs gate? |
|---|---|---|---|
| Daily-note template | plugin-internal | `bridge.create` | NO (bypass by construction) |
| Frontmatter repair | plugin-internal | `bridge.modify` | NO |
| Dreamtime distill | LLM-routed | `vault.create` / `vault.append` | YES |
| Ingest copy | LLM-routed | `vault.create` | YES |
| Lint writeback | plugin-internal | `bridge.modify` | NO |

This is checkable at code review time by grep for direct `bridge.*`
versus `server.getHandler("vault.*")` calls.

## Open questions (for the executor agent applying the proposal)

1. **Python preflight scope.** Does `mcp_server.py` `TOOL_MAP` expose a
   `vault_init` MCP tool? If yes, the Python preflight gate must
   explicitly bypass it (or the MCP-routed `vault_init` will be blocked
   by the Python gate even though the TS handler is not). If not, no
   action needed. **Verify by reading `mcp_server.py` `TOOL_MAP`
   before applying the proposal.**

2. **`vault.mkdir` is unchecked in the proposal.** `handlers.ts:153`
   has a `vault.mkdir` handler. It's a write operation -- an LLM can
   `mkdir .obsidian.bak/` and the proposal does not stop it. This needs
   a path-only check (`is_safe_to_write` without the content validator)
   added in the same commit as the create/modify/append gates.

3. **Allowlist fallback semantics.** Line 201-203 of `vault_safe_paths.py`
   refuses any unknown extension. For LLM-routed writes via the
   create/modify/append gates this is correct (markdown-first vault).
   For plugin-internal scaffolds it is not relevant because they bypass
   the gate. No action needed today; flag if option (b) ever activates.

## Findings that should feed back into the safety-wiring proposal

These are observations from W4 (critic agent), not part of the decision
itself. Capturing here so the executor agent can address them when
applying the proposal:

- **Proposal self-contradicts on gate layer** (proposal lines 5, 176, 190).
  This decision pins it: handler layer.
- **`vault.init` bypass is not mentioned in the proposal.** Whoever lands
  the proposal will hit this conflict on day one. This decision pre-empts
  it.
- **Allowlist fallback at `vault_safe_paths.py:201-203` is not mentioned
  in the proposal.** Every "just remove X from BLOCKED_EXTENSIONS" patch
  in the proposal becomes a two-line fix.
- **`vault.mkdir` is unchecked in the proposal** (`handlers.ts:153`). Open
  question #2 above.
- **TODOs at `vault_safe_paths.py:128-135` and `:194-200`** -- bare
  dotfile and extensionless file bypasses. Already documented as
  TODO(P2)/(P3) in commit `d798035`. Out of scope for the proposal but
  the executor should be aware.

## Sources

- `vault_safe_paths.py` -- `_CAVEMAN_SKIP_EXTENSIONS` (line 48-59),
  `ALLOWED_VAULT_EXTENSIONS` (line 87-91), `is_safe_to_write` allowlist
  fallback (line 201-203)
- `src/handlers.ts` -- `vault.init` scaffold writes `kb.yaml` via
  `bridge.create` (line 296-302), bypassing `vault.create` handler
- `docs/safety-wiring-proposal.md` -- gate-layer ambiguity between line 5
  ("bridge layer") and line 190 ("handler layer")
- `CLAUDE.md` -- "Plugin write operations must have dry-run mode"
  constraint and MCP-primary / WebSocket-fallback transport model
- W4 architect-critic review session, 2026-04-08

## Resolution of Open Questions (2026-04-08 session continuation)

Both open questions above were verified against the codebase during
the W7 dispatch prep. The ADR primary path still holds; no
amendment needed. This section pins the findings so the executor
agent does not re-derive them.

### Resolution of Q1 -- Python preflight scope for `vault_init`

**Verified: `TOOL_MAP` in `mcp_server.py` does NOT expose `vault_init`.**

Reading `mcp_server.py:247-263`, `TOOL_MAP` contains exactly 17
entries: `vault_read`, `vault_list`, `vault_stat`, `vault_exists`,
`vault_create`, `vault_modify`, `vault_append`, `vault_delete`,
`vault_rename`, `vault_search`, `vault_search_by_tag`,
`vault_search_by_frontmatter`, `vault_get_metadata`, `vault_graph`,
`vault_backlinks`, `vault_lint`, `vault_batch`. Neither `vault_init`
nor `vault_mkdir` is present.

**Consequences for the preflight gate:**

1. **Direct MCP path**: LLM clients cannot reach `vault.init` through
   the MCP server at all. No explicit bypass is needed in
   `_preflight_write_gate`.
2. **Batch sub-op path**: `vault.batch` forwards to the TS handler,
   which (at `handlers.ts:218`) accepts any method that starts with
   `vault.` and is not `vault.batch`. So `vault.init` IS reachable
   as a batch sub-op. But the Python batch preflight's `reverse_map`
   (proposal patch 3) only knows `vault.create`, `vault.modify`,
   `vault.append`, `vault.delete`, `vault.rename`. `vault.init` is
   absent, so `sub_tool = reverse_map.get("vault.init") = None` and
   the loop continues without gating. This is the desired behavior:
   the Python batch preflight silently allows `vault.init` sub-ops.
3. **TS authoritative layer**: `vault.init` calls `bridge.create`
   and `bridge.mkdir` DIRECTLY (`handlers.ts:256,266,300`), bypassing
   `server.getHandler("vault.create")`, so the handler-layer gate
   does not see these calls. The ADR primary path (handler-layer
   wiring) naturally exempts `vault.init` without any trust flag.

**Action for executor**: No code change. Document this in a comment
above the `reverse_map` in `_preflight_write_gate` so the next reader
understands why `vault.init` is absent.

### Resolution of Q2 -- `vault.mkdir` gate design

**Verified: reusing `isSafeToWrite` for `vault.mkdir` is safe.**

Walked every code path in `vault_safe_paths.py:190-236`
(`is_safe_to_write`) against mkdir use cases:

| Input path | Path traversal | Blocked dir | Blocked ext | Allowlist fallback | Result |
|---|---|---|---|---|---|
| `notes/new-folder` | no | no | no (empty suffix) | no (empty suffix, `if suffix` skips) | **TRUE** (correct, valid mkdir) |
| `.obsidian.bak/foo` | no | **YES** (`.obsidian.bak` in `BLOCKED_DIRECTORIES`) | -- | -- | **FALSE** (correct, blocked) |
| `../secret` | **YES** (traversal) | -- | -- | -- | **FALSE** (correct) |
| `foo.yaml` (dotted dir name) | no | no | **YES** (`.yaml` in blocklist) | -- | **FALSE** (acceptable; markdown-first vault, dotted dir names rare) |
| `.env` (bare dotfile dir) | no | no | no (P2 bug: `PurePosixPath(".env").suffix == ""`) | no (empty suffix) | **TRUE** (inherits existing P2 TODO; NOT a W7 regression) |

**Key insight**: the P3 TODO at `vault_safe_paths.py:226-232`
(extensionless files pass) is a **bug for files** (Makefile, README
would slip through `vault.create`) but the **correct behavior for
directories**. The two use cases share the same function and the
shared semantics happen to be right for the mkdir branch.

**TS patch for handlers.ts:153** (`vault.mkdir`):

```ts
server.registerHandler("vault.mkdir", async (p) => {
  const path = validatePath(p.path);
  if (!isSafeToWrite(path, { allowCanvas: false })) {
    throw {
      code: RPC_SAFETY_PATH_BLOCKED,
      message: "Safety gate rejected mkdir: protected path",
      data: { gate: "path", path },
    } as RpcError;
  }
  // NOTE: no validateVaultWrite call -- mkdir has no content.
  if (isDryRun(p, settings))
    return { dryRun: true, action: "mkdir", path, wouldSucceed: !bridge.exists(path) };
  await safeExec(() => bridge.mkdir(path));
  return { ok: true, path };
});
```

**Python patch for `_preflight_write_gate`**: add `vault_mkdir` to
`WRITE_TOOLS_PATH_GATED` but NOT to `WRITE_TOOLS_CONTENT_GATED`.
Also extend the batch `reverse_map` with `"vault.mkdir":
"vault_mkdir"` so batch sub-ops get the path check.

```python
WRITE_TOOLS_PATH_GATED = {
    "vault_create", "vault_modify", "vault_append",
    "vault_delete", "vault_rename", "vault_mkdir",
}
WRITE_TOOLS_CONTENT_GATED = {"vault_create", "vault_modify", "vault_append"}

# In batch reverse_map:
reverse_map = {
    "vault.create": "vault_create",
    "vault.modify": "vault_modify",
    "vault.append": "vault_append",
    "vault.delete": "vault_delete",
    "vault.rename": "vault_rename",
    "vault.mkdir":  "vault_mkdir",   # path-only (no content gate)
}
```

**Note**: `vault_mkdir` is NOT added to `TOOL_MAP` in this patch.
MCP clients still cannot reach `vault.mkdir` directly -- only via
`vault.batch`. Adding `vault_mkdir` to `TOOL_MAP` is a separate
feature decision out of scope for W7.

**Test invariants for W7** (add to safety test suite):

```python
# Python
def test_mkdir_path_safe_valid_dir():
    assert is_safe_to_write("notes/new-folder") is True

def test_mkdir_path_rejected_obsidian_bak():
    assert is_safe_to_write(".obsidian.bak/anything") is False

def test_batch_vault_mkdir_sub_op_path_gated():
    # Construct a vault_batch call with a vault.mkdir sub-op targeting
    # ".obsidian" -- expect safety_gate_rejected with batch index 0.
    ...
```

```ts
// vitest
it("vault.mkdir rejects protected directory names", async () => {
  await expect(handler({ path: ".obsidian/plugins" }))
    .rejects.toMatchObject({ code: RPC_SAFETY_PATH_BLOCKED });
});

it("vault.mkdir allows normal directory creation", async () => {
  const r = await handler({ path: "notes/new-topic", dryRun: true });
  expect(r).toMatchObject({ dryRun: true, action: "mkdir" });
});

it("vault.init scaffold mkdirs bypass the gate (handler-layer ADR invariant)", async () => {
  // vault.init calls bridge.mkdir directly, not server.getHandler("vault.mkdir")
  // so safety gate must NOT intercept scaffold directory creation.
  const r = await initHandler({ topic: "test-topic" });
  expect(r.ok).toBe(true);
});
```

### Status

ADR primary path confirmed. No changes to the decision above. The
handler-layer wiring plus the `vault.mkdir` extension and the
documented `vault.init` batch exemption are sufficient. Proceed
to W7 dispatch.
