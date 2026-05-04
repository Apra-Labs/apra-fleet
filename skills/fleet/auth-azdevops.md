# AzDO Auth

PATs. Empty user, PAT as password.

1. Org settings > PAT.
2. Scopes, expiry.
3. Provide token + org URL.

**Deploy:**
provision_vcs_auth(id, provider: azure-devops, org_url, pat).

**Scopes:**
Code, PR, Build.

**Test:**
curl -u :pat <url>, git ls-remote <url>.

**Reuse:**
credential_store_set name=az_pat.
Use: {.az_pat}}.

**Notes:**
- No App tokens.
- Org URL: no trailing path.