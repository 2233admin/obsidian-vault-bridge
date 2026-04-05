# MCP Tool Reference

## vault.init

Scaffold a new knowledge base topic.

```json
{ "method": "vault.init", "params": { "topic": "machine-learning" } }
```

Returns: `{ ok, topic, created: [...paths], skipped: [...paths], summary }`

Creates: raw/articles/, raw/papers/, raw/notes/, raw/transcripts/, wiki/, wiki/summaries/, wiki/concepts/, wiki/queries/, schema/, _index.md, _sources.md, _categories.md, Log.md, schema/CLAUDE.md, kb.yaml

Idempotent. Existing files are never overwritten.

## vault.read

```json
{ "method": "vault.read", "params": { "path": "KB/ml/wiki/_index.md" } }
```

Returns: `{ content: "..." }`

## vault.create

```json
{ "method": "vault.create", "params": { "path": "KB/ml/raw/articles/attention.md", "content": "...", "dryRun": false } }
```

Fails if file exists. Dry-run returns preview without writing.

## vault.modify

```json
{ "method": "vault.modify", "params": { "path": "...", "content": "...", "dryRun": false } }
```

Fails if file does not exist.

## vault.append

```json
{ "method": "vault.append", "params": { "path": "...", "content": "\n## New Section\n...", "dryRun": false } }
```

## vault.delete

```json
{ "method": "vault.delete", "params": { "path": "...", "force": true, "dryRun": false } }
```

## vault.rename

```json
{ "method": "vault.rename", "params": { "from": "old/path.md", "to": "new/path.md", "dryRun": false } }
```

## vault.search

```json
{ "method": "vault.search", "params": { "query": "attention mechanism", "glob": "KB/ml/wiki/**", "maxResults": 20, "context": 2 } }
```

Options: `regex` (bool), `caseSensitive` (bool), `glob` (path filter), `maxResults` (int), `context` (lines around match).

## vault.searchByTag

```json
{ "method": "vault.searchByTag", "params": { "tag": "concept" } }
```

## vault.searchByFrontmatter

```json
{ "method": "vault.searchByFrontmatter", "params": { "key": "coverage", "value": "low", "op": "eq" } }
```

Operators: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `contains`, `exists`, `not_exists`.

## vault.graph

```json
{ "method": "vault.graph", "params": { "type": "both" } }
```

Type: `"backlinks"`, `"outgoing"`, or `"both"`.

## vault.backlinks

```json
{ "method": "vault.backlinks", "params": { "path": "wiki/concepts/attention.md" } }
```

## vault.batch

```json
{
  "method": "vault.batch",
  "params": {
    "operations": [
      { "method": "vault.read", "params": { "path": "a.md" } },
      { "method": "vault.read", "params": { "path": "b.md" } }
    ]
  }
}
```

Sequential execution. Returns array of results with index, ok, result/error.

## vault.lint

```json
{ "method": "vault.lint", "params": { "requiredFrontmatter": ["title", "tags", "coverage"] } }
```

Checks: broken links, orphan files, missing frontmatter fields.

## vault.list / vault.stat / vault.exists

```json
{ "method": "vault.list", "params": { "path": "KB/ml/raw" } }
{ "method": "vault.stat", "params": { "path": "KB/ml/wiki/_index.md" } }
{ "method": "vault.exists", "params": { "path": "KB/ml/kb.yaml" } }
```
