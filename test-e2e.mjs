/**
 * E2E test for vault-bridge WebSocket server.
 * Requires: Obsidian running with vault-bridge plugin enabled on dev vault.
 * Usage: node test-e2e.mjs
 */
import WebSocket from "ws";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const portFile = join(homedir(), ".obsidian-ws-port");
let PORT, TOKEN;
try {
  const info = JSON.parse(readFileSync(portFile, "utf-8"));
  PORT = info.port;
  TOKEN = info.token;
} catch {
  console.error("Cannot read ~/.obsidian-ws-port -- is Obsidian running with vault-bridge?");
  process.exit(1);
}
const URL = `ws://127.0.0.1:${PORT}`;

let idSeq = 0;
let ws;
const pending = new Map();
let passed = 0;
let failed = 0;
let skipped = 0;

function call(method, params = {}) {
  return sendRequest(method, params, false);
}

function callEnvelope(method, params = {}) {
  return sendRequest(method, params, true);
}

function sendRequest(method, params = {}, full = false) {
  const id = ++idSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: ${method} (id=${id})`));
    }, 10000);
    pending.set(id, { resolve, reject, timer, method, full });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
  });
}

function log(label, data) {
  const s = JSON.stringify(data, null, 2);
  const preview = s.length > 400 ? s.slice(0, 400) + "...(truncated)" : s;
  console.log(`\n--- ${label} ---\n${preview}`);
}

function ok(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
    return false;
  }
  console.log(`  OK: ${msg}`);
  passed++;
  return true;
}

function hasReceipt(result, action) {
  return ok(typeof result.receipt === "object" && result.receipt !== null, `${action} receipt present`)
    && ok(result.receipt.action === action, `${action} receipt action`)
    && ok(typeof result.receipt.timestamp === "string", `${action} receipt timestamp`)
    && ok(Number.isInteger(result.receipt.bytesBefore), `${action} receipt bytesBefore integer`)
    && ok(Number.isInteger(result.receipt.bytesAfter), `${action} receipt bytesAfter integer`);
}

function matchGlobSpec(pattern, path) {
  const regex = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\\\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${regex}$`).test(path);
}

async function runTests() {
  const createContent = "---\ntitle: E2E\ntags: [test]\n---\n\n# Created by E2E\n";
  const modifyContent = "---\ntitle: E2E Modified\n---\n\n# Modified by E2E\n";
  const appendContent = "\n## Appended Section\n";

  // 1. authenticate
  const auth = await call("authenticate", { token: TOKEN });
  log("1. authenticate", auth);
  ok(auth.ok === true, "auth ok");
  ok(Array.isArray(auth.capabilities), "capabilities listed");

  // 2. listCapabilities
  const caps = await call("listCapabilities");
  log("2. listCapabilities", caps);
  ok(caps.methods.length > 10, `${caps.methods.length} methods registered`);

  // 3. matchGlob spec cases + EVNT-02 RPC surface
  ok(matchGlobSpec("KB/**", "KB/foo/bar.md"), "matchGlob matches recursive KB path");
  ok(!matchGlobSpec("KB/**", "Daily/foo.md"), "matchGlob rejects other roots");
  ok(matchGlobSpec("**/*.md", "Daily/foo.md"), "matchGlob matches markdown anywhere");
  ok(!matchGlobSpec("Daily/*.md", "Daily/sub/x.md"), "matchGlob keeps single-segment star local");
  ok(matchGlobSpec("Daily/?.md", "Daily/a.md"), "matchGlob matches single-char segment");
  ok(!matchGlobSpec("Daily/?.md", "Daily/ab.md"), "matchGlob rejects multi-char question mark");

  const eventsInitial = await call("events.list");
  log("3a. events.list initial", eventsInitial);
  ok(Array.isArray(eventsInitial.subscriptions), "events.list subscriptions array");

  const eventsSubscribed = await call("events.subscribe", { patterns: ["KB/**", "**/*.md"] });
  log("3b. events.subscribe", eventsSubscribed);
  ok(eventsSubscribed.ok === true, "events.subscribe ok");
  ok(eventsSubscribed.subscriptions.includes("KB/**"), "events.subscribe stores first pattern");
  ok(eventsSubscribed.subscriptions.includes("**/*.md"), "events.subscribe stores second pattern");

  const eventsAfterSubscribe = await call("events.list");
  log("3c. events.list subscribed", eventsAfterSubscribe);
  ok(eventsAfterSubscribe.subscriptions.length >= 2, "events.list reflects subscriptions");

  const eventsUnsubscribed = await call("events.unsubscribe", { patterns: ["KB/**", "**/*.md"] });
  log("3d. events.unsubscribe", eventsUnsubscribed);
  ok(eventsUnsubscribed.ok === true, "events.unsubscribe ok");
  ok(eventsUnsubscribed.subscriptions.length === 0, "events.unsubscribe clears patterns");

  // 4. vault.list (root) + SAFE-03 meta envelope
  const listEnvelope = await callEnvelope("vault.list", { path: "" });
  log("4. vault.list root", listEnvelope);
  ok(Number.isInteger(listEnvelope.meta?.estimatedTokens), "response meta estimatedTokens integer");
  ok(listEnvelope.meta.estimatedTokens === Math.ceil(JSON.stringify(listEnvelope.result).length / 4), "response meta estimatedTokens matches protocol formula");
  const list = listEnvelope.result;
  ok(Array.isArray(list.files), "files is array");
  ok(list.files.includes("Welcome.md"), "Welcome.md in list");
  ok(Array.isArray(list.folders), "folders is array");
  ok(list.folders.includes("subfolder"), "subfolder in list");

  // 5. vault.list (subfolder)
  const subList = await call("vault.list", { path: "subfolder" });
  log("5. vault.list subfolder", subList);
  ok(subList.files.some(f => f.includes("Nested Note")), "nested note found");

  // 5. vault.read
  const read = await call("vault.read", { path: "Welcome.md" });
  log("5. vault.read", read);
  ok(typeof read.content === "string", "content is string");
  ok(read.content.includes("vault-bridge"), "content correct");

  // 6. vault.read (nested)
  const readNested = await call("vault.read", { path: "subfolder/Nested Note.md" });
  log("6. vault.read nested", readNested);
  ok(readNested.content.includes("Nested"), "nested read works");

  // 7. vault.stat
  const stat = await call("vault.stat", { path: "Welcome.md" });
  log("7. vault.stat", stat);
  ok(stat.path === "Welcome.md", "stat path");
  ok(typeof stat.size === "number", "stat size");

  // 8. vault.exists
  const exists1 = await call("vault.exists", { path: "Welcome.md" });
  log("8a. vault.exists (true)", exists1);
  ok(exists1.exists === true, "existing file");

  const exists2 = await call("vault.exists", { path: "nope.md" });
  log("8b. vault.exists (false)", exists2);
  ok(exists2.exists === false, "nonexistent file");

  // 9. vault.create (dry-run, default)
  const createDry = await call("vault.create", { path: "E2E Test.md", content: "# test" });
  log("9. vault.create dry-run", createDry);
  ok(createDry.dryRun === true, "dry-run respected");

  // 10. vault.create (real)
  const createReal = await call("vault.create", {
    path: "E2E Test.md",
    content: createContent,
    dryRun: false,
  });
  log("10. vault.create real", createReal);
  ok(createReal.ok === true, "create succeeded");
  if (hasReceipt(createReal, "create")) {
    ok(createReal.receipt.path === "E2E Test.md", "create receipt path");
    ok(createReal.receipt.previousContent === null, "create previousContent null");
    ok(createReal.receipt.bytesBefore === 0, "create bytesBefore zero");
    ok(createReal.receipt.bytesAfter === Buffer.byteLength(createContent, "utf-8"), "create bytesAfter matches content size");
  }

  // 11. verify create
  const verifyCreate = await call("vault.read", { path: "E2E Test.md" });
  ok(verifyCreate.content.includes("Created by E2E"), "create persisted");

  // 12. vault.modify (dry-run)
  const modDry = await call("vault.modify", { path: "E2E Test.md", content: "modified" });
  log("12. vault.modify dry-run", modDry);
  ok(modDry.dryRun === true, "modify dry-run");

  // 13. vault.modify (real)
  const modReal = await call("vault.modify", {
    path: "E2E Test.md",
    content: modifyContent,
    dryRun: false,
  });
  log("13. vault.modify real", modReal);
  ok(modReal.ok === true, "modify succeeded");
  if (hasReceipt(modReal, "modify")) {
    ok(modReal.receipt.path === "E2E Test.md", "modify receipt path");
    ok(modReal.receipt.previousContent.includes("Created by E2E"), "modify previousContent captured");
    ok(modReal.receipt.bytesBefore === Buffer.byteLength(modReal.receipt.previousContent, "utf-8"), "modify bytesBefore matches prior content");
    ok(modReal.receipt.bytesAfter === Buffer.byteLength(modifyContent, "utf-8"), "modify bytesAfter matches new content");
  }

  const verifyMod = await call("vault.read", { path: "E2E Test.md" });
  ok(verifyMod.content.includes("Modified by E2E"), "modify persisted");

  // 14. vault.append
  const appendReal = await call("vault.append", {
    path: "E2E Test.md",
    content: appendContent,
    dryRun: false,
  });
  log("14. vault.append", appendReal);
  ok(appendReal.ok === true, "append succeeded");
  if (hasReceipt(appendReal, "append")) {
    ok(appendReal.receipt.path === "E2E Test.md", "append receipt path");
    ok(appendReal.receipt.previousContent.includes("Modified by E2E"), "append previousContent captured");
    ok(appendReal.receipt.bytesBefore === Buffer.byteLength(appendReal.receipt.previousContent, "utf-8"), "append bytesBefore matches prior content");
    ok(appendReal.receipt.bytesAfter === appendReal.receipt.bytesBefore + Buffer.byteLength(appendContent, "utf-8"), "append bytesAfter adds appended content");
  }

  const verifyAppend = await call("vault.read", { path: "E2E Test.md" });
  ok(verifyAppend.content.includes("Appended Section"), "append persisted");

  // 15. vault.rename (dry-run)
  const renameDry = await call("vault.rename", { from: "E2E Test.md", to: "E2E Renamed.md" });
  log("15. vault.rename dry-run", renameDry);
  ok(renameDry.dryRun === true, "rename dry-run");

  // 16. vault.rename (real)
  const renameReal = await call("vault.rename", {
    from: "E2E Test.md",
    to: "E2E Renamed.md",
    dryRun: false,
  });
  log("16. vault.rename real", renameReal);
  ok(renameReal.ok === true, "rename succeeded");
  if (hasReceipt(renameReal, "rename")) {
    ok(renameReal.path === "E2E Renamed.md", "rename result path");
    ok(renameReal.from === "E2E Test.md", "rename result from");
    ok(renameReal.to === "E2E Renamed.md", "rename result to");
    ok(renameReal.receipt.path === "E2E Test.md", "rename receipt source path");
    ok(renameReal.receipt.previousContent.includes("Appended Section"), "rename previousContent captured");
    ok(renameReal.receipt.bytesBefore === renameReal.receipt.bytesAfter, "rename bytes stable");
  }

  const verifyRename = await call("vault.exists", { path: "E2E Renamed.md" });
  ok(verifyRename.exists === true, "renamed file exists");

  // 17. vault.search
  const search = await call("vault.search", { query: "vault-bridge" });
  log("17. vault.search", search);
  ok(Array.isArray(search.results), "search returns results array");
  ok(search.results.length > 0, "search finds results");

  // 18. vault.getMetadata
  const meta = await call("vault.getMetadata", { path: "Welcome.md" });
  log("18. vault.getMetadata", meta);
  ok(meta.frontmatter !== undefined || meta.tags !== undefined, "metadata returned");

  // 19. vault.searchByTag
  const tagSearch = await call("vault.searchByTag", { tag: "test" });
  log("19. vault.searchByTag", tagSearch);
  ok(Array.isArray(tagSearch.files), "tag search files array");
  ok(tagSearch.files.length >= 2, `found ${tagSearch.files.length} tagged files`);

  // 20. vault.searchByFrontmatter
  const fmSearch = await call("vault.searchByFrontmatter", { key: "status", value: "active" });
  log("20. vault.searchByFrontmatter", fmSearch);
  ok(Array.isArray(fmSearch.files), "frontmatter search files array");

  // 21. vault.graph
  const graph = await call("vault.graph", { type: "both" });
  log("21. vault.graph", graph);
  ok(typeof graph === "object", "graph returns object");

  // 22. vault.backlinks
  const backlinks = await call("vault.backlinks", { path: "Welcome.md" });
  log("22. vault.backlinks Welcome.md", backlinks);
  ok(Array.isArray(backlinks.backlinks), "backlinks array");

  // 23. vault.lint
  const lint = await call("vault.lint", { requiredFrontmatter: ["title", "tags"] });
  log("23. vault.lint", lint);
  ok(typeof lint === "object", "lint returns object");

  // 24. vault.mkdir (dry-run)
  const mkdirDry = await call("vault.mkdir", { path: "e2e-testdir" });
  log("24. vault.mkdir dry-run", mkdirDry);
  ok(mkdirDry.dryRun === true, "mkdir dry-run");

  // 25. vault.batch
  const batch = await call("vault.batch", {
    dryRun: true,
    operations: [
      { method: "vault.read", params: { path: "Welcome.md" } },
      { method: "vault.exists", params: { path: "nope.md" } },
      { method: "vault.stat", params: { path: "Welcome.md" } },
    ],
  });
  log("25. vault.batch", batch);
  ok(batch.summary.total === 3, "batch total");
  ok(batch.summary.succeeded === 3, "batch all succeeded");

  // 26. vault.delete (cleanup)
  const del = await call("vault.delete", { path: "E2E Renamed.md", dryRun: false });
  log("26. vault.delete cleanup", del);
  ok(del.ok === true, "delete succeeded");
  if (hasReceipt(del, "delete")) {
    ok(del.receipt.path === "E2E Renamed.md", "delete receipt path");
    ok(del.receipt.previousContent.includes("Appended Section"), "delete previousContent captured");
    ok(del.receipt.bytesBefore === Buffer.byteLength(del.receipt.previousContent, "utf-8"), "delete bytesBefore matches prior content");
    ok(del.receipt.bytesAfter === 0, "delete bytesAfter zero");
  }

  const verifyDel = await call("vault.exists", { path: "E2E Renamed.md" });
  ok(verifyDel.exists === false, "deleted file gone");

  // 27. Error: read nonexistent
  try {
    await call("vault.read", { path: "does-not-exist.md" });
    ok(false, "should error on nonexistent");
  } catch (e) {
    ok(e.message.includes("-32001") || e.message.includes("Not found") || e.message.includes("not found"), "nonexistent file error");
  }

  // 28. Error: path traversal
  try {
    await call("vault.read", { path: "../../../etc/passwd" });
    ok(false, "should block path traversal");
  } catch (e) {
    ok(e.message.includes("traversal") || e.message.includes("-32602"), "path traversal blocked");
  }

  // --- EVNT-03 heartbeat smoke ---
  // Opt-out via SKIP_HEARTBEAT=1 because the wait is intentionally longer
  // than the server's 30s ping interval.
  if (process.env.SKIP_HEARTBEAT === "1") {
    skipped++;
    console.log("heartbeat smoke -- SKIPPED (SKIP_HEARTBEAT=1)");
  } else {
    console.log("heartbeat smoke -- waiting 35s for a server ping cycle...");
    await new Promise((resolve) => setTimeout(resolve, 35_000));
    try {
      const caps = await call("listCapabilities");
      ok(Array.isArray(caps.methods), "connection alive after 35s idle");
    } catch (e) {
      ok(false, `connection dropped during heartbeat smoke: ${e.message}`);
    }
  }

  // Summary
  console.log("\n========================================");
  console.log(`RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed === 0) {
    console.log("ALL TESTS PASSED");
  } else {
    console.log("SOME TESTS FAILED");
  }
  console.log("========================================\n");
  return failed;
}

// --- Main ---
ws = new WebSocket(URL);

ws.on("open", () => {
  console.log(`Connected to ${URL}`);
  runTests()
    .then((f) => { ws.close(); process.exit(f > 0 ? 1 : 0); })
    .catch((err) => { console.error("FATAL:", err); ws.close(); process.exit(1); });
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  const entry = pending.get(msg.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(msg.id);
  if (msg.error) {
    entry.reject(new Error(`${entry.method}: ${msg.error.message} (code=${msg.error.code})`));
  } else {
    entry.resolve(entry.full ? msg : msg.result);
  }
});

ws.on("error", (err) => {
  console.error("WS Error:", err.message);
  process.exit(1);
});
