-- vault_kg_schema.sql
-- Bi-temporal claim knowledge graph for vault-mind
-- Derived from mempalace/knowledge_graph.py:55-85 with vault-specific adaptations
--
-- Usage:
--   sqlite3 E:/knowledge/.vault-mind/vault_kg.db < vault_kg_schema.sql
--
-- Design notes:
--   - "entities" table is mempalace-compatible (id/name/type/properties/created_at)
--   - "claims" table replaces mempalace "triples" -- same shape + vault source_path
--     + source_line for jumping back to the exact note location.
--   - Bi-temporal-lite: (valid_from, valid_to) models when the claim was true
--     in the world. valid_to IS NULL means "still current". Invalidation is
--     UPDATE, not append. This matches mempalace's choice -- see Round 2 report
--     section 3 for why this is a conscious trade-off vs full SVCC bi-temporal.
--   - confidence column is kept for future probabilistic extraction; default 1.0
--     means "asserted by the user or by deterministic extraction".

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ---------------------------------------------------------------------------
-- entities: nodes in the claim graph
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
    id         TEXT PRIMARY KEY,           -- lowercased, underscored name
    name       TEXT NOT NULL,              -- canonical display name
    type       TEXT NOT NULL DEFAULT 'unknown',
                                           -- person / project / tool / concept /
                                           -- paper / dataset / note / unknown
    properties TEXT NOT NULL DEFAULT '{}', -- JSON blob, opaque to SQL
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

-- ---------------------------------------------------------------------------
-- claims: (subject, predicate, object, valid_from, valid_to) triples
--         + source_path / source_line back-reference to the vault note
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claims (
    id              TEXT PRIMARY KEY,      -- t_{subject}_{predicate}_{object}_{hash}
    subject         TEXT NOT NULL,         -- entity.id
    predicate       TEXT NOT NULL,         -- lowercased, underscored verb
    object          TEXT NOT NULL,         -- entity.id (for object literals, stored as-is)
    object_is_entity INTEGER NOT NULL DEFAULT 1,
                                           -- 0 = literal string, 1 = entity reference
    valid_from      TEXT,                  -- ISO date, nullable ("always")
    valid_to        TEXT,                  -- ISO date, nullable ("still current")
    confidence      REAL NOT NULL DEFAULT 1.0,
                                           -- 0.0-1.0; 1.0 = asserted, <1 = probabilistic
    source_path     TEXT,                  -- vault-relative path: "04-Research/foo.md"
    source_line     INTEGER,               -- line number (for jump-to-source)
    source_quote    TEXT,                  -- verbatim text fragment (<=280 chars)
    wing            TEXT,                  -- derived from source_path top folder
    extracted_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject) REFERENCES entities(id)
    -- NOTE: no FK on object because object_is_entity=0 means literal string
);

CREATE INDEX IF NOT EXISTS idx_claims_subject    ON claims(subject);
CREATE INDEX IF NOT EXISTS idx_claims_object     ON claims(object);
CREATE INDEX IF NOT EXISTS idx_claims_predicate  ON claims(predicate);
CREATE INDEX IF NOT EXISTS idx_claims_valid      ON claims(valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_claims_wing       ON claims(wing);
CREATE INDEX IF NOT EXISTS idx_claims_source     ON claims(source_path);
CREATE INDEX IF NOT EXISTS idx_claims_current
    ON claims(subject, predicate) WHERE valid_to IS NULL;

-- ---------------------------------------------------------------------------
-- claim_history: optional audit log for invalidations
-- Mempalace does NOT track this -- they UPDATE valid_to in place.
-- For a research vault where provenance matters, add this append-only log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id    TEXT NOT NULL,
    op          TEXT NOT NULL,  -- 'insert' / 'invalidate' / 'edit'
    old_valid_to TEXT,
    new_valid_to TEXT,
    changed_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    changed_by  TEXT,           -- agent name, e.g. "comrade-claude", "codex"
    FOREIGN KEY (claim_id) REFERENCES claims(id)
);

CREATE INDEX IF NOT EXISTS idx_history_claim ON claim_history(claim_id);

-- ---------------------------------------------------------------------------
-- Example seed data (commented out; uncomment to verify schema)
-- ---------------------------------------------------------------------------
-- INSERT OR IGNORE INTO entities (id, name, type) VALUES
--     ('vault_mind', 'vault-mind', 'project'),
--     ('mempalace',  'MemPalace',  'project'),
--     ('chromadb',   'ChromaDB',   'tool');
--
-- INSERT OR IGNORE INTO claims
--   (id, subject, predicate, object, object_is_entity, valid_from,
--    confidence, source_path, source_line, source_quote, wing)
-- VALUES
--   ('t_vault_mind_borrows_from_mempalace_0001',
--    'vault_mind', 'borrows_from', 'mempalace', 1, '2026-04-08',
--    1.0, '04-Research/mempalace-round2-2026-04-08.md', 13,
--    'Adopt the taxonomy pattern, the protocol-injection trick',
--    'research');

-- ---------------------------------------------------------------------------
-- Convenience views
-- ---------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS current_claims AS
    SELECT id, subject, predicate, object, object_is_entity,
           valid_from, confidence, source_path, source_line, source_quote, wing
    FROM claims
    WHERE valid_to IS NULL;

CREATE VIEW IF NOT EXISTS claims_by_wing AS
    SELECT wing, COUNT(*) AS claim_count
    FROM claims
    WHERE valid_to IS NULL
    GROUP BY wing
    ORDER BY claim_count DESC;

-- End of schema.
