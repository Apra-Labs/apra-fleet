-- The kb.sqlite schema exactly as apra-fleet v0.4.5 creates it (SqliteProvider.init,
-- dumped from sqlite_master with the FTS5 shadow tables left out: CREATE VIRTUAL
-- TABLE recreates them). Used by tests that open a KB built before the keyword
-- index existed. Do not edit: it pins the upgrade baseline.

CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        source_files TEXT NOT NULL DEFAULT '[]',
        symbols TEXT NOT NULL DEFAULT '[]',
        module TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL DEFAULT '',
        content_hash_type TEXT NOT NULL DEFAULT 'sha256',
        stale INTEGER NOT NULL DEFAULT 0,
        flagged_for_review INTEGER NOT NULL DEFAULT 0,
        contradiction_of TEXT,
        author TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'doer',
        confidence TEXT NOT NULL DEFAULT 'INFERRED',
        scope TEXT NOT NULL DEFAULT 'project',
        created_at TEXT NOT NULL,
        superseded_at TEXT,
        promoted_at TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT
      , source_file_hashes TEXT NOT NULL DEFAULT '{}', retired_reason TEXT, local_basis_only INTEGER NOT NULL DEFAULT 0, demoted_at TEXT, demoted_basis_hashes TEXT NOT NULL DEFAULT '{}', bible_updated_at TEXT);

CREATE INDEX idx_entries_type ON entries(type);

CREATE INDEX idx_entries_confidence ON entries(confidence);

CREATE INDEX idx_entries_created_at ON entries(created_at);

CREATE INDEX idx_entries_superseded_at ON entries(superseded_at);

CREATE INDEX idx_entries_use_count ON entries(use_count);

CREATE VIRTUAL TABLE entries_fts USING fts5(
        title,
        summary,
        content,
        tags,
        content='entries',
        content_rowid='rowid'
      );

CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, title, summary, content, tags)
        VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
      END;

CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, summary, content, tags)
        VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
      END;

CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, summary, content, tags)
        VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
        INSERT INTO entries_fts(rowid, title, summary, content, tags)
        VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
      END;

CREATE TABLE links (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, link_type)
      );

CREATE TABLE trusted_bible_blobs (
        blob_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
