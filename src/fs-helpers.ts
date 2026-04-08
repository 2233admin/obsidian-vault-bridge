import type { App } from "obsidian";

/**
 * Get the absolute filesystem path of the current vault.
 *
 * Obsidian's Vault.adapter is typed as DataAdapter, but the concrete
 * FileSystemAdapter (used on desktop) exposes a basePath property.
 * We duck-type rather than importing FileSystemAdapter so that (a) this
 * module stays compile-clean on mobile stubs and (b) tests can use a
 * plain object adapter with a basePath field without extending the real
 * Obsidian class hierarchy.
 *
 * Returns null if the adapter does not expose a string basePath (e.g.
 * the mobile CapacitorAdapter, or a test stub without the field).
 * Callers decide whether to throw, fall back to a placeholder, or skip
 * the write -- the three existing sites have different needs.
 */
export function getVaultBasePath(app: App): string | null {
  const adapter: unknown = app.vault.adapter;
  if (adapter && typeof adapter === "object" && "basePath" in adapter) {
    const bp = (adapter as { basePath: unknown }).basePath;
    if (typeof bp === "string" && bp.length > 0) return bp;
  }
  return null;
}
