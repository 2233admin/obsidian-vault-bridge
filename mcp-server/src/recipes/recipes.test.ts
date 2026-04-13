/**
 * Recipe framework + registry unit tests.
 *
 * Uses node:test (built-in) + temporary directories for filesystem isolation.
 * No external dependencies required.
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { parseRecipe, getRecipeStatus, runHealthCheck, appendHeartbeat } from './_framework.js';
import { scanRecipes, findRecipe } from './_registry.js';
import type { Recipe } from './_types.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Create a unique temp dir for a test run. */
function makeTempDir(): string {
  const dir = join(tmpdir(), `vault-mind-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRecipe(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

const VALID_RECIPE_CONTENT = `---
id: test-recipe
name: Test Recipe
version: 0.1.0
description: A test recipe for unit tests
category: sense
secrets:
  - name: TEST_TOKEN
    description: A test token
    where: https://example.com
health_checks:
  - command: 'echo OK'
---

# Test Recipe

Body text here.
`;

const MINIMAL_RECIPE_CONTENT = `---
id: minimal-recipe
name: Minimal Recipe
version: 1.0.0
description: Minimal recipe with no secrets or health checks
category: infra
---

# Minimal

No secrets needed.
`;

// Collect temp dirs to clean up after all tests
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── parseRecipe ───────────────────────────────────────────────────────────────

describe('parseRecipe -- valid inputs', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); tempDirs.push(dir); });

  test('parses full recipe with secrets and health_checks', () => {
    const fp = writeRecipe(dir, 'test.md', VALID_RECIPE_CONTENT);
    const recipe = parseRecipe(fp);
    assert.equal(recipe.frontmatter.id, 'test-recipe');
    assert.equal(recipe.frontmatter.name, 'Test Recipe');
    assert.equal(recipe.frontmatter.version, '0.1.0');
    assert.equal(recipe.frontmatter.description, 'A test recipe for unit tests');
    assert.equal(recipe.frontmatter.category, 'sense');
    assert.equal(recipe.frontmatter.secrets?.length, 1);
    assert.equal(recipe.frontmatter.secrets?.[0].name, 'TEST_TOKEN');
    assert.equal(recipe.frontmatter.health_checks?.length, 1);
    assert.equal(recipe.frontmatter.health_checks?.[0].command, 'echo OK');
    assert.ok(recipe.body.includes('Body text here'));
    assert.equal(recipe.filePath, fp);
  });

  test('parses minimal recipe with no secrets or health_checks', () => {
    const fp = writeRecipe(dir, 'minimal.md', MINIMAL_RECIPE_CONTENT);
    const recipe = parseRecipe(fp);
    assert.equal(recipe.frontmatter.id, 'minimal-recipe');
    assert.equal(recipe.frontmatter.category, 'infra');
    assert.equal(recipe.frontmatter.secrets, undefined);
    assert.equal(recipe.frontmatter.health_checks, undefined);
  });

  test('coerces numeric version to string', () => {
    const content = `---
id: ver-num
name: Version Number Test
version: 1
description: version is integer
category: infra
---

Body.
`;
    const fp = writeRecipe(dir, 'ver.md', content);
    const recipe = parseRecipe(fp);
    // YAML parses bare `1` as number; framework must coerce to string
    assert.equal(typeof recipe.frontmatter.version, 'string');
    assert.equal(recipe.frontmatter.version, '1');
  });

  test('handles requires: [] inline syntax as empty array', () => {
    const content = `---
id: req-empty
name: Requires Empty
version: 0.1.0
description: requires inline empty
category: reflex
requires: []
---

Body.
`;
    const fp = writeRecipe(dir, 'req.md', content);
    const recipe = parseRecipe(fp);
    // inline `[]` would naively parse as the string "[]" — must be coerced
    assert.deepEqual(recipe.frontmatter.requires, []);
  });

  test('all three valid category values are accepted', () => {
    for (const cat of ['infra', 'sense', 'reflex'] as const) {
      const content = `---
id: cat-${cat}
name: Cat ${cat}
version: 0.1.0
description: category test
category: ${cat}
---

Body.
`;
      const fp = writeRecipe(dir, `cat-${cat}.md`, content);
      const recipe = parseRecipe(fp);
      assert.equal(recipe.frontmatter.category, cat);
    }
  });
});

describe('parseRecipe -- invalid inputs', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); tempDirs.push(dir); });

  test('throws when frontmatter delimiter is missing', () => {
    const fp = writeRecipe(dir, 'no-fm.md', '# No frontmatter\n\nJust a body.');
    assert.throws(() => parseRecipe(fp), /no valid frontmatter/);
  });

  test('throws when required field id is missing', () => {
    const content = `---
name: Missing ID
version: 0.1.0
description: no id
category: infra
---

Body.
`;
    const fp = writeRecipe(dir, 'noid.md', content);
    assert.throws(() => parseRecipe(fp), /missing required field 'id'/);
  });

  test('throws when required field category is missing', () => {
    const content = `---
id: no-cat
name: No Category
version: 0.1.0
description: no category
---

Body.
`;
    const fp = writeRecipe(dir, 'nocat.md', content);
    assert.throws(() => parseRecipe(fp), /missing required field 'category'/);
  });

  test('throws on invalid category value', () => {
    const content = `---
id: bad-cat
name: Bad Category
version: 0.1.0
description: bad category
category: output
---

Body.
`;
    const fp = writeRecipe(dir, 'badcat.md', content);
    assert.throws(() => parseRecipe(fp), /invalid category/);
  });

  test('throws when secret item is missing name field', () => {
    const content = `---
id: bad-secret
name: Bad Secret
version: 0.1.0
description: secret missing name
category: sense
secrets:
  - description: No name field here
    where: https://example.com
---

Body.
`;
    const fp = writeRecipe(dir, 'badsecret.md', content);
    assert.throws(() => parseRecipe(fp), /each secret must have a 'name' string field/);
  });

  test('throws when health_check item is missing command field', () => {
    const content = `---
id: bad-hc
name: Bad HealthCheck
version: 0.1.0
description: health_check missing command
category: infra
health_checks:
  - description: No command field
---

Body.
`;
    const fp = writeRecipe(dir, 'badhc.md', content);
    assert.throws(() => parseRecipe(fp), /each health_check must have a 'command' string field/);
  });
});

// ── getRecipeStatus ───────────────────────────────────────────────────────────

describe('getRecipeStatus', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); tempDirs.push(dir); });

  function makeRecipe(overrides: Partial<Recipe['frontmatter']> = {}): Recipe {
    return {
      frontmatter: {
        id: 'test', name: 'Test', version: '0.1.0',
        description: 'desc', category: 'sense',
        ...overrides,
      },
      body: '',
      filePath: '/fake/path.md',
    };
  }

  test('configured when recipe has no secrets', () => {
    const status = getRecipeStatus(makeRecipe({ secrets: [] }));
    assert.equal(status.code, 'configured');
    assert.deepEqual(status.secrets_present, []);
    assert.deepEqual(status.secrets_missing, []);
  });

  test('configured when all secrets are in env', () => {
    process.env['_TEST_VAULT_TOKEN_A'] = 'abc';
    try {
      const status = getRecipeStatus(makeRecipe({
        secrets: [{ name: '_TEST_VAULT_TOKEN_A', description: 'test', where: 'n/a' }],
      }));
      assert.equal(status.code, 'configured');
      assert.deepEqual(status.secrets_present, ['_TEST_VAULT_TOKEN_A']);
      assert.deepEqual(status.secrets_missing, []);
    } finally {
      delete process.env['_TEST_VAULT_TOKEN_A'];
    }
  });

  test('unconfigured when secret is absent from env', () => {
    delete process.env['_TEST_VAULT_TOKEN_ABSENT'];
    const status = getRecipeStatus(makeRecipe({
      secrets: [{ name: '_TEST_VAULT_TOKEN_ABSENT', description: 'test', where: 'n/a' }],
    }));
    assert.equal(status.code, 'unconfigured');
    assert.deepEqual(status.secrets_missing, ['_TEST_VAULT_TOKEN_ABSENT']);
    assert.deepEqual(status.secrets_present, []);
  });

  test('unconfigured when some secrets present, some missing', () => {
    process.env['_TEST_VAULT_PRESENT'] = 'val';
    delete process.env['_TEST_VAULT_MISSING'];
    try {
      const status = getRecipeStatus(makeRecipe({
        secrets: [
          { name: '_TEST_VAULT_PRESENT', description: '', where: '' },
          { name: '_TEST_VAULT_MISSING', description: '', where: '' },
        ],
      }));
      assert.equal(status.code, 'unconfigured');
      assert.deepEqual(status.secrets_present, ['_TEST_VAULT_PRESENT']);
      assert.deepEqual(status.secrets_missing, ['_TEST_VAULT_MISSING']);
    } finally {
      delete process.env['_TEST_VAULT_PRESENT'];
    }
  });

  test('empty string env var counts as missing', () => {
    process.env['_TEST_VAULT_EMPTY'] = '';
    try {
      const status = getRecipeStatus(makeRecipe({
        secrets: [{ name: '_TEST_VAULT_EMPTY', description: '', where: '' }],
      }));
      assert.equal(status.code, 'unconfigured');
      assert.deepEqual(status.secrets_missing, ['_TEST_VAULT_EMPTY']);
    } finally {
      delete process.env['_TEST_VAULT_EMPTY'];
    }
  });
});

// ── runHealthCheck ────────────────────────────────────────────────────────────

describe('runHealthCheck', () => {
  test('returns ok=true for passing command', () => {
    const result = runHealthCheck('echo OK');
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('OK'));
  });

  test('returns ok=false for failing command', () => {
    const result = runHealthCheck('exit 1');
    assert.equal(result.ok, false);
  });

  test('returns ok=false for nonexistent command', () => {
    const result = runHealthCheck('this_command_does_not_exist_vault_mind_test_12345');
    assert.equal(result.ok, false);
    assert.ok(result.output.length > 0);
  });

  test('captures stdout in output', () => {
    const result = runHealthCheck('echo hello-world');
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('hello-world'));
  });
});

// ── appendHeartbeat ───────────────────────────────────────────────────────────

describe('appendHeartbeat', () => {
  // appendHeartbeat writes to ~/.vault-mind/recipes/{id}/heartbeat.jsonl
  // Use a unique id to avoid cross-test pollution
  const testId = `_test-${randomUUID()}`;

  after(() => {
    const dir = join(homedir(), '.vault-mind', 'recipes', testId);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('creates heartbeat.jsonl and appends valid JSONL', () => {
    const event = { ts: '2026-04-14T00:00:00Z', event: 'sync', data: { fetched: 5 } };
    appendHeartbeat(testId, event);

    const heartbeatPath = join(homedir(), '.vault-mind', 'recipes', testId, 'heartbeat.jsonl');
    assert.ok(existsSync(heartbeatPath));

    const lines = readFileSync(heartbeatPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.ts, '2026-04-14T00:00:00Z');
    assert.equal(parsed.event, 'sync');
    assert.equal(parsed.data.fetched, 5);
  });

  test('appends multiple events — each on its own line', () => {
    const e1 = { ts: '2026-04-14T01:00:00Z', event: 'doctor', data: { ok: true } };
    const e2 = { ts: '2026-04-14T02:00:00Z', event: 'doctor', data: { ok: false } };
    appendHeartbeat(testId, e1);
    appendHeartbeat(testId, e2);

    const heartbeatPath = join(homedir(), '.vault-mind', 'recipes', testId, 'heartbeat.jsonl');
    const lines = readFileSync(heartbeatPath, 'utf8').trim().split('\n');
    // At least 2 lines (may have more from prior test)
    assert.ok(lines.length >= 2);
    // Every line must be valid JSON
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });
});

// ── scanRecipes + findRecipe ──────────────────────────────────────────────────

describe('scanRecipes', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
    tempDirs.push(dir);
  });

  test('returns [] for non-existent directory', () => {
    const recipes = scanRecipes('/nonexistent/path/vault-mind-test');
    assert.deepEqual(recipes, []);
  });

  test('returns [] for empty directory', () => {
    const recipes = scanRecipes(dir);
    assert.deepEqual(recipes, []);
  });

  test('parses a valid recipe file', () => {
    writeRecipe(dir, 'my-recipe.md', VALID_RECIPE_CONTENT);
    const recipes = scanRecipes(dir);
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0].frontmatter.id, 'test-recipe');
  });

  test('skips _ prefixed files', () => {
    writeRecipe(dir, '_types.md', VALID_RECIPE_CONTENT);
    writeRecipe(dir, 'real.md', MINIMAL_RECIPE_CONTENT);
    const recipes = scanRecipes(dir);
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0].frontmatter.id, 'minimal-recipe');
  });

  test('skips non-.md files', () => {
    writeRecipe(dir, 'collector.ts', 'console.log("not a recipe")');
    writeRecipe(dir, 'readme.txt', 'not a recipe');
    writeRecipe(dir, 'real.md', MINIMAL_RECIPE_CONTENT);
    const recipes = scanRecipes(dir);
    assert.equal(recipes.length, 1);
  });

  test('skips malformed recipe without throwing', () => {
    writeRecipe(dir, 'bad.md', 'no frontmatter here');
    writeRecipe(dir, 'good.md', MINIMAL_RECIPE_CONTENT);
    // Should not throw; malformed file is skipped
    const recipes = scanRecipes(dir);
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0].frontmatter.id, 'minimal-recipe');
  });

  test('returns multiple recipes from the same directory', () => {
    writeRecipe(dir, 'r1.md', VALID_RECIPE_CONTENT);
    writeRecipe(dir, 'r2.md', MINIMAL_RECIPE_CONTENT);
    const recipes = scanRecipes(dir);
    assert.equal(recipes.length, 2);
    const ids = recipes.map(r => r.frontmatter.id).sort();
    assert.deepEqual(ids, ['minimal-recipe', 'test-recipe']);
  });

  test('cache: default dir is cached after first call (bypass via recipesDir param)', () => {
    // When using recipesDir override, result is NOT cached
    writeRecipe(dir, 'r1.md', VALID_RECIPE_CONTENT);
    const first = scanRecipes(dir);
    // Add a second file after first scan
    writeRecipe(dir, 'r2.md', MINIMAL_RECIPE_CONTENT);
    const second = scanRecipes(dir); // override bypasses cache
    // Both calls should see their respective filesystem state
    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
  });
});

describe('findRecipe', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
    tempDirs.push(dir);
  });

  test('finds recipe by id', () => {
    writeRecipe(dir, 'r.md', VALID_RECIPE_CONTENT);
    const recipe = findRecipe('test-recipe', dir);
    assert.ok(recipe);
    assert.equal(recipe.frontmatter.id, 'test-recipe');
  });

  test('returns undefined for unknown id', () => {
    writeRecipe(dir, 'r.md', VALID_RECIPE_CONTENT);
    const recipe = findRecipe('nonexistent-id', dir);
    assert.equal(recipe, undefined);
  });

  test('returns undefined from empty directory', () => {
    const recipe = findRecipe('test-recipe', dir);
    assert.equal(recipe, undefined);
  });
});
