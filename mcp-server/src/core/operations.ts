import type { Operation } from './types.js';

export const operations: Operation[] = [
  {
    name: 'vault.read',
    namespace: 'vault',
    description: "Read a note's content",
    mutating: false,
    params: {
      path: { type: 'string', required: true, description: 'Vault-relative path to the note' },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.read', params),
  },
  {
    name: 'vault.exists',
    namespace: 'vault',
    description: 'Check if a path exists',
    mutating: false,
    params: {
      path: { type: 'string', required: true, description: 'Vault-relative path to check' },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.exists', params),
  },
  {
    name: 'vault.list',
    namespace: 'vault',
    description: 'List files and folders',
    mutating: false,
    params: {
      path: { type: 'string', required: false, description: 'Vault-relative directory path (default: root)', default: '' },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.list', params),
  },
  {
    name: 'vault.stat',
    namespace: 'vault',
    description: 'Get file/folder metadata',
    mutating: false,
    params: {
      path: { type: 'string', required: true, description: 'Vault-relative path' },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.stat', params),
  },
  {
    name: 'vault.create',
    namespace: 'vault',
    description: 'Create a new note (dry-run by default)',
    mutating: true,
    params: {
      path: { type: 'string', required: true, description: 'Vault-relative path for the new note' },
      content: { type: 'string', required: false, description: 'Initial content' },
      dryRun: { type: 'boolean', required: false, description: 'Simulate without writing (default: true)', default: true },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.create', params),
  },
  {
    name: 'vault.modify',
    namespace: 'vault',
    description: 'Overwrite an existing note',
    mutating: true,
    params: {
      path: { type: 'string', required: true, description: 'Vault-relative path to the note' },
      content: { type: 'string', required: true, description: 'New content' },
      dryRun: { type: 'boolean', required: false, description: 'Simulate without writing (default: true)', default: true },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.modify', params),
  },
  {
    name: 'vault.append',
    namespace: 'vault',
    description: 'Append content to a note',
    mutating: true,
    params: {
      path: { type: 'string', required: true, description: 'Vault-relative path to the note' },
      content: { type: 'string', required: true, description: 'Content to append' },
      dryRun: { type: 'boolean', required: false, description: 'Simulate without writing (default: true)', default: true },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.append', params),
  },
  {
    name: 'vault.delete',
    namespace: 'vault',
    description: 'Delete a note or folder',
    mutating: true,
    params: {
      path: { type: 'string', required: true, description: 'Vault-relative path to delete' },
      dryRun: { type: 'boolean', required: false, description: 'Simulate without deleting (default: true)', default: true },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.delete', params),
  },
  {
    name: 'vault.rename',
    namespace: 'vault',
    description: 'Rename/move a file',
    mutating: true,
    params: {
      from: { type: 'string', required: true, description: 'Source vault-relative path' },
      to: { type: 'string', required: true, description: 'Destination vault-relative path' },
      dryRun: { type: 'boolean', required: false, description: 'Simulate without moving (default: true)', default: true },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.rename', params),
  },
  {
    name: 'vault.mkdir',
    namespace: 'vault',
    description: 'Create a directory',
    mutating: true,
    params: {
      path: { type: 'string', required: true, description: 'Vault-relative directory path to create' },
      dryRun: { type: 'boolean', required: false, description: 'Simulate without creating (default: true)', default: true },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.mkdir', params),
  },
  {
    name: 'vault.search',
    namespace: 'vault',
    description: 'Fulltext search across vault',
    mutating: false,
    params: {
      query: { type: 'string', required: true, description: 'Search query string' },
      regex: { type: 'boolean', required: false, description: 'Treat query as regex' },
      caseSensitive: { type: 'boolean', required: false, description: 'Case-sensitive matching' },
      maxResults: { type: 'number', required: false, description: 'Maximum results to return (default: 50)', default: 50 },
      glob: { type: 'string', required: false, description: 'Glob pattern to restrict search scope' },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.search', params),
  },
  {
    name: 'vault.searchByTag',
    namespace: 'vault',
    description: 'Find notes with a given tag',
    mutating: false,
    params: {
      tag: { type: 'string', required: true, description: 'Tag to search for (with or without leading #)' },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.searchByTag', params),
  },
  {
    name: 'vault.searchByFrontmatter',
    namespace: 'vault',
    description: 'Find notes by frontmatter key-value',
    mutating: false,
    params: {
      key: { type: 'string', required: true, description: 'Frontmatter key to filter on' },
      value: { type: 'string', required: false, description: 'Value to compare against' },
      op: { type: 'string', required: false, description: 'Comparison operator (default: eq)', default: 'eq', enum: ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'regex', 'exists'] },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.searchByFrontmatter', params),
  },
  {
    name: 'vault.graph',
    namespace: 'vault',
    description: 'Get link graph of vault',
    mutating: false,
    params: {
      type: { type: 'string', required: false, description: 'Link type filter (default: both)', default: 'both', enum: ['resolved', 'unresolved', 'both'] },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.graph', params),
  },
  {
    name: 'vault.backlinks',
    namespace: 'vault',
    description: 'Find notes linking to a note',
    mutating: false,
    params: {
      path: { type: 'string', required: true, description: 'Vault-relative path of the target note' },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.backlinks', params),
  },
  {
    name: 'vault.batch',
    namespace: 'vault',
    description: 'Execute multiple vault operations',
    mutating: false,
    params: {
      operations: { type: 'array', required: true, description: 'Array of {method, params} objects to execute' },
      dryRun: { type: 'boolean', required: false, description: 'Apply dryRun to all mutating operations in the batch' },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.batch', params),
  },
  {
    name: 'vault.lint',
    namespace: 'vault',
    description: 'Check vault health',
    mutating: false,
    params: {
      requiredFrontmatter: { type: 'array', required: false, description: 'List of frontmatter keys that every note must have' },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.lint', params),
  },
  {
    name: 'vault.init',
    namespace: 'vault',
    description: 'Scaffold a new knowledge base topic',
    mutating: true,
    params: {
      topic: { type: 'string', required: true, description: 'Topic name (used as directory name and KB title)' },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.init', params),
  },
  {
    name: 'vault.getMetadata',
    namespace: 'vault',
    description: 'Get parsed metadata for a note',
    mutating: false,
    params: {
      path: { type: 'string', required: true, description: 'Vault-relative path to the note' },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.getMetadata', params),
  },
  {
    name: 'vault.externalSearch',
    namespace: 'vault',
    description: 'Search via external search engine',
    mutating: false,
    params: {
      query: { type: 'string', required: true, description: 'Search query string' },
    },
    handler: async (ctx, params) => ctx.vault.execute('vault.externalSearch', params),
  },
];
