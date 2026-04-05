export interface VaultBridgeSettings {
  port: number;
  token: string;
  dryRunDefault: boolean;
}

export const DEFAULT_SETTINGS: VaultBridgeSettings = {
  port: 48765,
  token: "",
  dryRunDefault: true,
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
