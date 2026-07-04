-- Hub service MVP schema (apra-fleet-us9.4).
-- Postgres-only per docs/adr-hub-persistence.md "Decision" section --
-- no Redis/NATS for the MVP. See that doc's "What this means for the hub
-- service MVP" section for the field-level rationale behind relay_queue
-- and the UNLOGGED choice for presence.

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS machines (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  hostname      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_machines_workspace ON machines(workspace_id);

CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  machine_id    TEXT REFERENCES machines(id),
  name          TEXT NOT NULL,
  provider      TEXT NOT NULL,
  work_folder   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_members_workspace ON members(workspace_id);

-- JWT revocation: point lookup by jti on every request. A plain indexed
-- table is no meaningfully different from a Redis TTL-keyed set at this
-- access pattern and scale (ADR section "Option A: Postgres-only").
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti         TEXT PRIMARY KEY,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);

-- Presence is UNLOGGED: a deliberate, named exception to "durability
-- everywhere" -- losing it on a hard crash is acceptable, spokes reconnect
-- and re-announce (the normal recovery path, not a failure mode).
CREATE UNLOGGED TABLE IF NOT EXISTS presence (
  machine_id  TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  status      TEXT NOT NULL,
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, member_id)
);

-- The single most important correctness surface in the MVP: at-least-once
-- relay. envelope_id is unique per (workspace_id, target_member_id) so
-- re-admission (a spoke retrying a send after a dropped ack) is idempotent
-- -- it does not create a duplicate deliverable envelope.
-- created_at is TTL zero-point: hub ADMISSION time, never the originator's
-- own timestamp (docs/hub-spoke-wire-protocol.md sections 3, 5, 6).
CREATE TABLE IF NOT EXISTS relay_queue (
  id                 BIGSERIAL PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  target_member_id   TEXT NOT NULL,
  envelope_id        TEXT NOT NULL,
  kind               TEXT NOT NULL,
  payload            JSONB NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'delivered', 'acked', 'expired')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ttl_ms             BIGINT NOT NULL,
  acked_at           TIMESTAMPTZ,
  UNIQUE (workspace_id, target_member_id, envelope_id)
);
-- Serves both the FIFO delivery read (status='pending' for a target,
-- ordered by id) and the reconnect-flush read from the same shape.
CREATE INDEX IF NOT EXISTS idx_relay_queue_delivery
  ON relay_queue (target_member_id, status, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  actor_id      TEXT,
  action        TEXT NOT NULL,
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_workspace_time ON audit_log(workspace_id, created_at);

-- Table shape only for the MVP (apra-fleet-us9.4 scope) -- the
-- dashboard-facing rollup/consumer is apra-fleet-us9.15, out of scope here.
CREATE TABLE IF NOT EXISTS usage_ledger (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  project_id    TEXT,
  member_id     TEXT NOT NULL,
  tokens        BIGINT NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(12, 6) NOT NULL DEFAULT 0,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_workspace ON usage_ledger(workspace_id);
