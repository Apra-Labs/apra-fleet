-- Machine enrollment tokens (apra-fleet-us9.5 continuation / apra-fleet-fnz.4,
-- re-scoped per docs/hub-spoke-master-plan.md section 4: "every machine
-- enrolls against the hub URL... its issuer becomes the dashboard/hub and
-- the address it embeds is the hub's, not the orchestrator's" -- Journey
-- B's original LAN/mDNS discovery framing is explicitly superseded; this
-- is a hub-mediated exchange, not a local peer-to-peer one, so it needs
-- NO inbound network exposure on any spoke machine.
--
-- Short-lived, single-use, workspace-scoped (docs/hub-spoke-master-plan.md
-- section 4: "the enrollment-token CONCEPT survives intact -- short-lived,
-- single-use, bound to a scope and role").
CREATE TABLE IF NOT EXISTS enrollment_tokens (
  token         TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  role          TEXT NOT NULL DEFAULT 'spoke',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_workspace ON enrollment_tokens(workspace_id);
