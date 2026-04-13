import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecipe } from './_framework.js';
import type { Recipe } from './_types.js';

const DEFAULT_RECIPES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'recipes');

let _cache: Recipe[] | null = null;

/**
 * Scan the recipes/ directory for all .md files (excluding _ prefixed files).
 * Results are cached for the lifetime of the process. Pass recipesDir to
 * bypass the cache.
 */
export function scanRecipes(recipesDir?: string): Recipe[] {
  if (!recipesDir && _cache) return _cache;
  const dir = recipesDir ?? DEFAULT_RECIPES_DIR;
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const recipes: Recipe[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name.startsWith('_')) continue;

    const filePath = join(dir, entry.name);
    try {
      recipes.push(parseRecipe(filePath));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[recipes] Skipping malformed recipe ${filePath}: ${msg}\n`);
    }
  }

  if (!recipesDir) _cache = recipes;
  return recipes;
}

/**
 * Find a recipe by id.
 */
export function findRecipe(id: string, recipesDir?: string): Recipe | undefined {
  return scanRecipes(recipesDir).find(r => r.frontmatter.id === id);
}
