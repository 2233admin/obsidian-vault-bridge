#!/usr/bin/env node
// setup.js -- one-command installer for obsidian-llm-wiki
// Usage: node setup.js
// Zero npm dependencies: only Node.js built-ins (fs, path, os, readline)

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

// ---------------------------------------------------------------------------
// ANSI color helpers (no chalk)
// ---------------------------------------------------------------------------
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  red:    "\x1b[31m",
  blue:   "\x1b[34m",
  gray:   "\x1b[90m",
};

function ok(msg)   { console.log(`${C.green}  [ok]${C.reset} ${msg}`); }
function info(msg) { console.log(`${C.cyan}  [--]${C.reset} ${msg}`); }
function warn(msg) { console.log(`${C.yellow}  [!!]${C.reset} ${msg}`); }
function fail(msg) { console.log(`${C.red}  [xx]${C.reset} ${msg}`); }
function step(msg) { console.log(`\n${C.bold}${C.blue}==>${C.reset}${C.bold} ${msg}${C.reset}`); }
function dim(msg)  { console.log(`${C.gray}      ${msg}${C.reset}`); }

// ---------------------------------------------------------------------------
// Project root (directory this script lives in)
// ---------------------------------------------------------------------------
const PROJECT_DIR = path.resolve(__dirname);
const CONNECTOR_PATH = path.join(PROJECT_DIR, "connector.js");
const BUILD_ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

// ---------------------------------------------------------------------------
// Step 1: Locate Obsidian config file (platform-aware)
// ---------------------------------------------------------------------------
function obsidianConfigPath() {
  const platform = process.platform;
  if (platform === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "Obsidian", "obsidian.json");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
  }
  // Linux / other
  return path.join(os.homedir(), ".config", "obsidian", "obsidian.json");
}

// Parse Obsidian's obsidian.json and return an array of vault paths.
// obsidian.json shape: { "vaults": { "<id>": { "path": "/abs/path", "ts": 1234 }, ... } }
function readObsidianVaults() {
  const cfgPath = obsidianConfigPath();
  try {
    const raw = fs.readFileSync(cfgPath, "utf-8");
    const cfg = JSON.parse(raw);
    const vaults = cfg.vaults;
    if (!vaults || typeof vaults !== "object") return [];
    return Object.values(vaults)
      .map(v => v.path)
      .filter(p => typeof p === "string" && p.length > 0);
  } catch (err) {
    if (err.code === "ENOENT") return null; // Obsidian not installed / config not found
    warn(`Could not parse Obsidian config at ${cfgPath}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 2: Readline helpers
// ---------------------------------------------------------------------------
function createRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

// ---------------------------------------------------------------------------
// Step 3: Pick vault path interactively
// ---------------------------------------------------------------------------
async function pickVaultPath(rl) {
  step("Detecting Obsidian vaults");

  const vaults = readObsidianVaults();

  if (vaults === null) {
    warn("Obsidian config not found -- Obsidian may not be installed, or config is in a non-standard location.");
    info("You can still install the plugin manually by entering the vault path.");
    const input = await ask(rl, `${C.cyan}  Enter your vault path (absolute): ${C.reset}`);
    if (!input) { fail("No vault path provided. Aborting."); process.exit(1); }
    return input;
  }

  // Filter to vaults that actually exist on disk
  const existing = vaults.filter(p => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });

  const missing = vaults.filter(p => !existing.includes(p));
  if (missing.length > 0) {
    missing.forEach(p => warn(`Vault path not found on disk (skipping): ${p}`));
  }

  if (existing.length === 0) {
    warn("No accessible vault paths found in Obsidian config.");
    const input = await ask(rl, `${C.cyan}  Enter your vault path (absolute): ${C.reset}`);
    if (!input) { fail("No vault path provided. Aborting."); process.exit(1); }
    return input;
  }

  if (existing.length === 1) {
    ok(`Found vault: ${existing[0]}`);
    const confirm = await ask(rl, `${C.cyan}  Use this vault? (Y/n): ${C.reset}`);
    if (confirm.toLowerCase() === "n") {
      const input = await ask(rl, `${C.cyan}  Enter your vault path (absolute): ${C.reset}`);
      if (!input) { fail("No vault path provided. Aborting."); process.exit(1); }
      return input;
    }
    return existing[0];
  }

  // Multiple vaults -- let user pick
  info(`Found ${existing.length} vaults:`);
  existing.forEach((p, i) => console.log(`  ${C.bold}${i + 1}.${C.reset} ${p}`));
  console.log(`  ${C.bold}${existing.length + 1}.${C.reset} Enter a different path`);

  const answer = await ask(rl, `${C.cyan}  Pick a vault [1-${existing.length + 1}]: ${C.reset}`);
  const idx = parseInt(answer, 10);

  if (idx >= 1 && idx <= existing.length) {
    return existing[idx - 1];
  }

  // Custom path
  const input = await ask(rl, `${C.cyan}  Enter your vault path (absolute): ${C.reset}`);
  if (!input) { fail("No vault path provided. Aborting."); process.exit(1); }
  return input;
}

// ---------------------------------------------------------------------------
// Step 4: Install plugin files into vault
// ---------------------------------------------------------------------------
function installPlugin(vaultPath) {
  step("Installing plugin to vault");

  // Validate vault path
  try {
    const stat = fs.statSync(vaultPath);
    if (!stat.isDirectory()) {
      fail(`${vaultPath} is not a directory.`);
      process.exit(1);
    }
  } catch (err) {
    fail(`Vault path does not exist: ${vaultPath} (${err.message})`);
    process.exit(1);
  }

  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", "vault-bridge");

  // Create plugin directory
  try {
    fs.mkdirSync(pluginDir, { recursive: true });
    dim(`Created: ${pluginDir}`);
  } catch (err) {
    fail(`Could not create plugin directory: ${err.message}`);
    process.exit(1);
  }

  // Verify build artifacts exist
  const missing = BUILD_ARTIFACTS.filter(f => {
    try { fs.statSync(path.join(PROJECT_DIR, f)); return false; } catch { return true; }
  });

  if (missing.length > 0) {
    fail(`Build artifacts missing: ${missing.join(", ")}`);
    info(`Run 'npm install && npm run build' first, then re-run setup.js`);
    process.exit(1);
  }

  // Copy each artifact
  let allOk = true;
  for (const file of BUILD_ARTIFACTS) {
    const src = path.join(PROJECT_DIR, file);
    const dst = path.join(pluginDir, file);
    try {
      fs.copyFileSync(src, dst);
      ok(`Copied ${file} -> ${path.relative(vaultPath, dst)}`);
    } catch (err) {
      fail(`Failed to copy ${file}: ${err.message}`);
      allOk = false;
    }
  }

  if (!allOk) {
    fail("Some files could not be copied. Check permissions and try again.");
    process.exit(1);
  }

  return pluginDir;
}

// ---------------------------------------------------------------------------
// Step 5: Configure MCP for Claude Code
// ---------------------------------------------------------------------------
function claudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function buildMcpEntry(vaultPath) {
  return {
    command: "node",
    args: [CONNECTOR_PATH, vaultPath],
  };
}

function printMcpSnippet(vaultPath) {
  const snippet = {
    mcpServers: {
      "vault-bridge": buildMcpEntry(vaultPath),
    },
  };
  console.log();
  console.log(`${C.gray}  -- MCP config snippet (for manual use) ---------${C.reset}`);
  console.log(
    JSON.stringify(snippet, null, 2)
      .split("\n")
      .map(l => `  ${C.gray}${l}${C.reset}`)
      .join("\n")
  );
  console.log(`${C.gray}  -------------------------------------------------${C.reset}`);
  console.log();
}

async function configureMcp(rl, vaultPath) {
  step("Configuring MCP for Claude Code");

  const settingsPath = claudeSettingsPath();
  info(`Target: ${settingsPath}`);
  printMcpSnippet(vaultPath);

  const answer = await ask(rl, `${C.cyan}  Add vault-bridge to Claude Code settings? (Y/n): ${C.reset}`);
  if (answer.toLowerCase() === "n") {
    info("Skipped -- paste the snippet above into ~/.claude/settings.json manually.");
    return;
  }

  // Read existing settings (create empty object if file doesn't exist)
  let settings = {};
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    settings = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") {
      warn(`Could not read ${settingsPath}: ${err.message}`);
      warn("Will create a new settings file.");
    }
  }

  // Merge mcpServers (never overwrite other entries)
  if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
    settings.mcpServers = {};
  }
  settings.mcpServers["vault-bridge"] = buildMcpEntry(vaultPath);

  // Ensure ~/.claude directory exists
  const claudeDir = path.dirname(settingsPath);
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
  } catch (err) {
    fail(`Could not create ~/.claude directory: ${err.message}`);
    process.exit(1);
  }

  // Write back
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    ok(`Updated ${settingsPath}`);
    dim(`Added: mcpServers["vault-bridge"]`);
  } catch (err) {
    fail(`Could not write ${settingsPath}: ${err.message}`);
    info("Paste the snippet above into ~/.claude/settings.json manually.");
  }
}

// ---------------------------------------------------------------------------
// Step 6: Print final instructions
// ---------------------------------------------------------------------------
function printFinalInstructions(vaultPath) {
  step("Setup complete");

  console.log(`
${C.bold}  Next steps:${C.reset}

  ${C.yellow}1.${C.reset} Restart Obsidian (or disable then re-enable Vault Bridge in
     ${C.dim}Settings > Community Plugins > Vault Bridge${C.reset})

  ${C.yellow}2.${C.reset} Verify the connection:
     ${C.cyan}node demo.js${C.reset}

  ${C.yellow}3.${C.reset} In Claude Code, try:
     ${C.green}"Search my notes for..."${C.reset}
     ${C.green}"What did I write about X last month?"${C.reset}
     ${C.green}"Create a note called Meeting Notes with..."${C.reset}

  ${C.gray}Vault: ${vaultPath}${C.reset}
  ${C.gray}Connector: ${CONNECTOR_PATH}${C.reset}
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`
${C.bold}${C.blue}  Vault Bridge Setup${C.reset}
  ${C.gray}obsidian-llm-wiki v${require("./package.json").version}${C.reset}
  ${C.dim}Turn your Obsidian vault into an MCP server for AI agents.${C.reset}
`);

  const rl = createRl();

  try {
    // 1. Pick vault
    const vaultPath = await pickVaultPath(rl);

    // 2. Install plugin
    installPlugin(vaultPath);

    // 3. Configure MCP
    await configureMcp(rl, vaultPath);

    // 4. Done
    printFinalInstructions(vaultPath);

  } catch (err) {
    console.error(`\n${C.red}Unexpected error:${C.reset}`, err.message || err);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
