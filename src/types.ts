export interface VaultBridgeSettings {
  port: number;
  token: string;
  dryRunDefault: boolean;
  safety: {
    enabled: boolean;                                              // default: true
    allowCanvas: boolean;                                         // default: false
    requireFrontmatter: "never" | "new-files-only" | "always";   // default: "new-files-only"
  };
}

export const DEFAULT_SETTINGS: VaultBridgeSettings = {
  port: 48765,
  token: "",
  dryRunDefault: true,
  safety: {
    enabled: true,
    allowCanvas: false,
    requireFrontmatter: "new-files-only",
  },
};

export interface ClientState {
  authenticated: boolean;
}

export interface SearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
  glob?: string;
  context?: number;
}

export interface SearchMatch {
  line: number;
  text: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface SearchResult {
  path: string;
  matches: SearchMatch[];
}
