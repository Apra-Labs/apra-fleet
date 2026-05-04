# Bitbucket Auth

App passwords.

1. Profile > App passwords.
2. Scopes: epository, pullrequest.
3. Provide token, email, workspace.

**Deploy:**
provision_vcs_auth(id, provider: bitbucket, email, api_token, workspace).

**Test:**
curl -u email:token <url>, git ls-remote <url>.

**Reuse:**
credential_store_set name=bb_token.
Use: {.bb_token}}.