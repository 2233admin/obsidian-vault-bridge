import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const raw = readFileSync("vault-mind.yaml", "utf-8");

function parseSimpleYaml(raw) {
  const result = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    result[key] = val;
  }
  return result;
}

const parsed = parseSimpleYaml(raw);
console.log("Parsed result:");
console.log(JSON.stringify(parsed, null, 2));
console.log("vault_path from yaml:", JSON.stringify(parsed.vault_path));
console.log("resolve(vault_path):", resolve(parsed.vault_path || ""));
console.log("process.cwd():", process.cwd());
