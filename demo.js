// Demo script: shows vault-bridge in action
// Simulates what an AI agent does when connected to your vault
const WebSocket = require("ws");
const token = require("fs").readFileSync(require("os").homedir() + "/.obsidian-ws-port", "utf-8");
const { port, token: tk } = JSON.parse(token);

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
let id = 0;

function call(method, params) {
  return new Promise(resolve => {
    const myId = ++id;
    const handler = (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.id === myId) { ws.off("message", handler); resolve(msg); }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id: myId }));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function demo() {
  // Auth
  const auth = await call("authenticate", { token: tk });
  console.log("\x1b[36m> Connected to Obsidian vault\x1b[0m");
  console.log(`  ${auth.result.capabilities.length} tools available\n`);
  await sleep(800);

  // Search
  console.log('\x1b[33m> "Search my notes for knowledge compilation"\x1b[0m');
  await sleep(500);
  const search = await call("vault.search", { query: "compiled knowledge", maxResults: 5 });
  const results = search.result.results;
  console.log(`  Found ${search.result.totalMatches} matches in ${results.length} files:`);
  for (const r of results.slice(0, 3)) {
    console.log(`  \x1b[32m  ${r.path}\x1b[0m (${r.matches.length} matches)`);
  }
  console.log();
  await sleep(800);

  // Read
  const target = results[0]?.path || "Welcome.md";
  console.log(`\x1b[33m> Reading ${target}\x1b[0m`);
  await sleep(500);
  const read = await call("vault.read", { path: target });
  const content = read.result.content;
  const preview = content.split("\n").slice(0, 8).join("\n");
  console.log(`  ${content.length} chars, preview:\n`);
  console.log(`  \x1b[90m${preview}\x1b[0m\n`);
  await sleep(800);

  // Metadata
  console.log(`\x1b[33m> Getting metadata + backlinks\x1b[0m`);
  await sleep(500);
  const meta = await call("vault.getMetadata", { path: target });
  const links = meta.result.links || [];
  const tags = meta.result.tags || [];
  console.log(`  Links: ${links.map(l => "[[" + l.link + "]]").join(", ") || "none"}`);
  console.log(`  Tags: ${tags.map(t => t.tag).join(", ") || "none"}`);
  const bl = await call("vault.backlinks", { path: target });
  console.log(`  Backlinks: ${bl.result.backlinks.length} notes link here\n`);
  await sleep(800);

  // Graph
  console.log(`\x1b[33m> Vault knowledge graph\x1b[0m`);
  await sleep(500);
  const graph = await call("vault.graph", {});
  console.log(`  ${graph.result.nodes.length} nodes, ${graph.result.edges.length} edges, ${graph.result.orphans.length} orphans\n`);

  console.log("\x1b[36m> Done. Your AI agent has full access to your vault.\x1b[0m");
  ws.close();
}

ws.on("open", demo);
ws.on("error", e => { console.error("Error:", e.message); process.exit(1); });
