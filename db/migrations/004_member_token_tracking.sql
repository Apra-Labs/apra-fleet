-- Per-member current JWT identity (apra-fleet-us9.5 continuation): needed
-- so rotation knows which jti to revoke (jwt-revocation.ts) before minting
-- a new one. Nullable -- a member created but never issued a token (or
-- whose token was revoked without an immediate rotation) has none.
ALTER TABLE members ADD COLUMN IF NOT EXISTS current_jti TEXT;
