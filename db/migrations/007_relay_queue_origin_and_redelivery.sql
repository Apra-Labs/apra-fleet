-- apra-fleet-b55: completes docs/hub-spoke-wire-protocol.md sections 5-6.
-- origin_member_id: the ORIGINATING member/machine that submitted the
-- envelope -- needed so a TTL-expired envelope can generate a synthetic
-- failed result addressed back to whoever is waiting on it (section 6).
-- Nullable: hub-authored envelopes (none exist yet) would have no spoke
-- origin; every spoke-authored relay envelope submitted via
-- envelope-routes.ts always sets it.
-- delivered_at: last time this row was pushed to a spoke. Lets
-- fetchDeliverable() honor ack_timeout_ms (default 10s, section 5 step 5)
-- by only re-serving an already-'delivered' row once that long has
-- elapsed, instead of re-sending on every poll cycle.
ALTER TABLE relay_queue ADD COLUMN IF NOT EXISTS origin_member_id TEXT;
ALTER TABLE relay_queue ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
