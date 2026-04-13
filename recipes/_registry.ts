import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecipe } from './_framework.js';
import type { Recipe } from './_types.js';

const DEFAULT_RECIPES_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Scan the recipes/ directory for all .md files (excluding _ prefixed files).
 * Returns parsed Recipe objects.
 */
export function scanRecipes(recipesDir?: string): Recipe[] {
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
    } catch {
      // Skip malformed recipe files silently
    }
  }

  return recipes;
}

/**
 * Find a recipe by id.
 */
export function findRecipe(id: string, recipesDir?: string): Recipe | undefined {
  return scanRecipes(recipesDir).find(r => r.frontmatter.id === id);
}
