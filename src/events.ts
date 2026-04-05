import { App, TFile, EventRef } from "obsidian";
import type { WsServer } from "./server";

export function registerVaultEvents(app: App, server: WsServer): EventRef[] {
  const refs: EventRef[] = [];

  refs.push(
    app.vault.on("create", (file) => {
      server.broadcastEvent("vault:create", {
        path: file.path,
        type: file instanceof TFile ? "file" : "folder",
      });
    }),
  );

  refs.push(
    app.vault.on("modify", (file) => {
      server.broadcastEvent("vault:modify", { path: file.path });
    }),
  );

  refs.push(
    app.vault.on("delete", (file) => {
      server.broadcastEvent("vault:delete", {
        path: file.path,
        type: file instanceof TFile ? "file" : "folder",
      });
    }),
  );

  refs.push(
    app.vault.on("rename", (file, oldPath) => {
      server.broadcastEvent("vault:rename", {
        path: file.path,
        oldPath,
        type: file instanceof TFile ? "file" : "folder",
      });
    }),
  );

  refs.push(
    app.metadataCache.on("changed", (file, _data, cache) => {
      server.broadcastEvent("metadata:changed", {
        path: file.path,
        tags: cache.tags?.map((t) => t.tag),
        links: cache.links?.map((l) => l.link),
      });
    }),
  );

  return refs;
}
