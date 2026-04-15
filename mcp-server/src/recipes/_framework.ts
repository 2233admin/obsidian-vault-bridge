import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { Recipe, RecipeFrontmatter, RecipeStatus, RecipeEvent } from './_types.js';

/**
 * Parse a simple YAML value: string, boolean, number, or null.
 * Arrays and nested objects are handled by the caller.
 */
function parseScalar(raw: string): string | boolean | number | null {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  const n = Number(s);
  if (!isNaN(n) && s !== '') return n;
  // Strip surrounding quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Minimal line-by-line YAML parser sufficient for recipe frontmatter.
 * Supports:
 *   - Top-level key: value
 *   - Top-level key:\n  - item  (string array)
 *   - Top-level key:\n  nested_key: value  (object / object array)
 */
function parseYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }

    const topMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
    if (!topMatch) { i++; continue; }

    const key = topMatch[1];
    const rest = topMatch[2].trim();

    if (rest !== '') {
      // Inline value — handle inline empty array []
      result[key] = rest === '[]' ? [] : parseScalar(rest);
      i++;
    } else {
      // Block: peek at next lines for array or object items
      const items: unknown[] = [];
      const obj: Record<string, unknown> = {};
      let isArray = false;
      let isObject = false;
      i++;

      while (i < lines.length) {
        const sub = lines[i];
        if (sub.trim() === '' || sub.trim().startsWith('#')) { i++; continue; }
        // Must be indented
        if (!/^\s+/.test(sub)) break;

        const arrayItemMatch = sub.match(/^\s+-\s+(.*)/);
        if (arrayItemMatch) {
          isArray = true;
          const itemVal = arrayItemMatch[1].trim();
          // Could be an inline object: "- key: value" style
          const inlineObjMatch = itemVal.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
          if (inlineObjMatch) {
            // Gather consecutive indented lines at same depth as part of this object
            const itemObj: Record<string, unknown> = {};
            itemObj[inlineObjMatch[1]] = parseScalar(inlineObjMatch[2]);
            i++;
            // Collect sibling key-values at the same indentation level (no leading -)
            while (i < lines.length) {
              const sibLine = lines[i];
              if (sibLine.trim() === '' || sibLine.trim().startsWith('#')) { i++; continue; }
              if (!/^\s+/.test(sibLine)) break;
              if (/^\s+-/.test(sibLine)) break; // next array item
              const sibMatch = sibLine.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
              if (!sibMatch) break;
              itemObj[sibMatch[1]] = parseScalar(sibMatch[2].trim());
              i++;
            }
            items.push(itemObj);
          } else {
            items.push(parseScalar(itemVal));
            i++;
          }
        } else {
          // Nested key: value
          const kvMatch = sub.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
          if (kvMatch) {
            isObject = true;
            obj[kvMatch[1]] = parseScalar(kvMatch[2].trim());
          }
          i++;
        }
      }

      if (isArray) {
        result[key] = items;
      } else if (isObject) {
        result[key] = obj;
      } else {
        result[key] = null;
      }
    }
  }

  return result;
}

/**
 * Parse YAML frontmatter + markdown body from a recipe .md file.
 * Frontmatter is delimited by --- at start and end.
 */
export function parseRecipe(filePath: string): Recipe {
  const content = readFileSync(filePath, 'utf8');

  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)/);
  if (!fmMatch) {
    throw new Error(`Recipe file has no valid frontmatter: ${filePath}`);
  }

  const yamlText = fmMatch[1];
  const body = fmMatch[2];

  const raw = parseYaml(yamlText);

  // Validate required fields
  const required = ['id', 'name', 'version', 'description', 'category'] as const;
  for (const field of required) {
    if (raw[field] == null) {
      throw new Error(`Recipe frontmatter missing required field '${field}' in ${filePath}`);
    }
  }

  // Coerce numeric version to string (e.g. YAML `version: 1` -> "1")
  if (typeof raw.version === 'number') {
    raw.version = String(raw.version);
  }

  // Structural validation for optional array fields
  if (raw.secrets != null && !Array.isArray(raw.secrets)) {
    throw new Error(`Recipe '${filePath}': 'secrets' must be an array, got ${typeof raw.secrets}`);
  }
  if (raw.health_checks != null && !Array.isArray(raw.health_checks)) {
    throw new Error(`Recipe '${filePath}': 'health_checks' must be an array, got ${typeof raw.health_checks}`);
  }
  if (raw.requires != null && !Array.isArray(raw.requires)) {
    // requires: [] inline syntax may parse as string "[]" — treat it as empty array
    if (raw.requires === '[]') {
      raw.requires = [];
    } else {
      throw new Error(`Recipe '${filePath}': 'requires' must be an array, got ${typeof raw.requires}`);
    }
  }

  // Category enum validation
  const validCategories: string[] = ['infra', 'sense', 'reflex'];
  if (!validCategories.includes(raw.category as string)) {
    throw new Error(`Recipe '${filePath}': invalid category '${raw.category}', expected infra|sense|reflex`);
  }

  // Per-item shape validation for secrets array
  if (Array.isArray(raw.secrets)) {
    for (const s of raw.secrets as Array<Record<string, unknown>>) {
      if (typeof s.name !== 'string') {
        throw new Error(`Recipe '${filePath}': each secret must have a 'name' string field`);
      }
    }
  }

  // Per-item shape validation for health_checks array
  if (Array.isArray(raw.health_checks)) {
    for (const hc of raw.health_checks as Array<Record<string, unknown>>) {
      if (typeof hc.command !== 'string') {
        throw new Error(`Recipe '${filePath}': each health_check must have a 'command' string field`);
      }
    }
  }

  const frontmatter = raw as unknown as RecipeFrontmatter;

  return { frontmatter, body, filePath };
}

/**
 * Check which secrets are present/missing in process.env.
 * Returns RecipeStatus with code 'configured' if all secrets are present, else 'unconfigured'.
 */
export function getRecipeStatus(recipe: Recipe): RecipeStatus {
  const secrets = recipe.frontmatter.secrets ?? [];
  const present: string[] = [];
  const missing: string[] = [];

  for (const secret of secrets) {
    if (process.env[secret.name] != null && process.env[secret.name] !== '') {
      present.push(secret.name);
    } else {
      missing.push(secret.name);
    }
  }

  const code = missing.length === 0 ? 'configured' : 'unconfigured';

  return {
    id: recipe.frontmatter.id,
    code,
    secrets_present: present,
    secrets_missing: missing,
  };
}

/**
 * Run a health check command and return { ok, output }.
 * Uses execFileSync with explicit bash/sh, 10s timeout, captures stdout+stderr.
 */
export function runHealthCheck(command: string): { ok: boolean; output: string } {
  // Health check commands come from shipped recipe files (trusted authors).
  // We need an explicit POSIX shell because commands use $VAR expansion and &&.
  const shell = process.platform === 'win32' ? 'bash' : '/bin/sh';
  const shellFlag = '-c';
  try {
    const output = execFileSync(shell, [shellFlag, command], {
      timeout: 10_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: (output as string).trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
    return { ok: false, output };
  }
}

/**
 * Append a RecipeEvent to ~/.vault-mind/recipes/{recipeId}/heartbeat.jsonl.
 * Creates directory if it doesn't exist.
 */
export function appendHeartbeat(recipeId: string, event: RecipeEvent): void {
  const dir = join(homedir(), '.vault-mind', 'recipes', recipeId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, 'heartbeat.jsonl');
  appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
}
