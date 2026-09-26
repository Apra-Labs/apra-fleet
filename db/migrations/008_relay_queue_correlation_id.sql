-- apra-fleet-us9.12: closes a real gap found while building hub-brokered
-- file transfer -- docs/hub-spoke-wire-protocol.md section 3 specifies a
-- `correlation_id` field on every envelope (set on a response/result
-- envelope to the envelope_id of the request it answers), but it was never
-- persisted on relay_queue nor forwarded over the SSE delivery stream.
-- Without this column, an originating spoke (src/services/relay-request.ts,
-- src/services/file-transfer-relay.ts) can never actually match a
-- delivered result back to the request it was waiting on in the REAL
-- pipeline -- only in isolated unit tests that hand-construct the envelope.
ALTER TABLE relay_queue ADD COLUMN IF NOT EXISTS correlation_id TEXT;
