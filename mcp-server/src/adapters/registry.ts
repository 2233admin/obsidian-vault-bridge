/**
 * AdapterRegistry -- manages VaultMindAdapter instances.
 *
 * FilesystemAdapter is always registered as the default.
 * Additional adapters can be registered by name or capability.
 */

import type { VaultMindAdapter, AdapterCapability } from "./interface.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, VaultMindAdapter>();
  private defaultName: string | null = null;

  register(adapter: VaultMindAdapter): void {
    this.adapters.set(adapter.name, adapter);
    if (this.defaultName === null) {
      this.defaultName = adapter.name;
    }
  }

  unregister(name: string): boolean {
    const deleted = this.adapters.delete(name);
    if (this.defaultName === name) {
      this.defaultName = this.adapters.size > 0 ? this.adapters.keys().next().value ?? null : null;
    }
    return deleted;
  }

  get(name: string): VaultMindAdapter | undefined {
    return this.adapters.get(name);
  }

  getDefault(): VaultMindAdapter {
    if (this.defaultName === null) throw new Error("No adapters registered");
    const adapter = this.adapters.get(this.defaultName);
    if (!adapter) throw new Error(`Default adapter "${this.defaultName}" not found`);
    return adapter;
  }

  getByCapability(capability: AdapterCapability): VaultMindAdapter[] {
    return [...this.adapters.values()].filter((a) =>
      (a.capabilities as readonly AdapterCapability[]).includes(capability),
    );
  }

  list(): VaultMindAdapter[] {
    return [...this.adapters.values()];
  }

  setDefault(name: string): void {
    if (!this.adapters.has(name)) throw new Error(`Adapter "${name}" not registered`);
    this.defaultName = name;
  }
}
