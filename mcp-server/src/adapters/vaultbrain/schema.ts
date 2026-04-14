/**
 * VaultBrain schema -- minimal subset of GBrain's schema.
 * Four tables: pages, content_chunks, links, tags.
 * pgvector HNSW index for embedding search, pg_trgm + tsvector for keyword search.
 */

export const VAULTBRAIN_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS pages (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT,
  content TEXT,
  content_hash TEXT,
  search_vector tsvector,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_chunks (
  id SERIAL PRIMARY KEY,
  page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding vector(1536),
  token_count INTEGER,
  UNIQUE(slug, chunk_index)
);

CREATE TABLE IF NOT EXISTS links (
  id SERIAL PRIMARY KEY,
  from_slug TEXT NOT NULL,
  to_slug TEXT NOT NULL,
  UNIQUE(from_slug, to_slug)
);

CREATE TABLE IF NOT EXISTS tags (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL,
  tag TEXT NOT NULL,
  UNIQUE(slug, tag)
);

CREATE INDEX IF NOT EXISTS content_chunks_embedding_idx
  ON content_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS pages_search_vector_idx
  ON pages USING gin(search_vector);

CREATE INDEX IF NOT EXISTS pages_content_trgm_idx
  ON pages USING gin(content gin_trgm_ops);

CREATE OR REPLACE FUNCTION update_page_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A')
                    || setweight(to_tsvector('english', coalesce(NEW.content, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER pages_search_vector_trigger
BEFORE INSERT OR UPDATE ON pages
FOR EACH ROW EXECUTE FUNCTION update_page_search_vector();
`;
