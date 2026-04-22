# Azure Trusted Signing — GitHub Actions Integration

## Prerequisites
- Azure Trusted Signing account with validated org identity (Apra Labs Inc.)
- Public Trust certificate profile (NOT Private Trust — only Public Trust bypasses SmartScreen)
- App Registration in Entra ID with a Federated Credential (OIDC — no stored secret)
- Service Principal assigned the `Trusted Signing Certificate Profile Signer` role scoped to the signing account

---

## Security Considerations (Public Repo)

Since the repository is public, treat signing credentials with extra care:

- **Use OIDC only** — never store a client secret in GitHub secrets. OIDC issues short-lived tokens; there is no long-lived credential to leak.
- **Scope federated credentials tightly** — create one credential per trigger type (see below). A tag-scoped credential cannot be used by a branch push or a fork PR.
- **Fork PRs cannot access secrets or OIDC tokens** — GitHub blocks this by default. No action needed beyond not weakening `permissions`.
- **`id-token: write` on signing job only** — do not elevate the entire workflow; scope the permission to the job that needs it.
- **Store account name, profile name, and endpoint as secrets** — these are not passwords, but they identify your signing account; no reason to expose them in public workflow YAML.

---

## Required GitHub Secrets

| Secret | Value |
|---|---|
| `AZURE_CLIENT_ID` | App Registration (client) ID |
| `AZURE_TENANT_ID` | Entra ID tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |
| `AZURE_SIGNING_ENDPOINT` | Region endpoint (e.g. `https://eus.codesigning.azure.net/`) |
| `AZURE_SIGNING_ACCOUNT` | Trusted Signing account name |
| `AZURE_CERT_PROFILE` | Certificate profile name |

---

## OIDC Setup: Federated Credentials

Create two federated credentials on the App Registration:

| Name | Subject | Purpose |
|---|---|---|
| `github-release-tags` | `repo:Apra-Labs/apra-fleet:ref:refs/tags/*` | Production signing on tag push |
| `github-sign-test` | `repo:Apra-Labs/apra-fleet:ref:refs/heads/main` | Hello-world test runs via `workflow_dispatch` |

No client secret needed. Both credentials are read-only from GitHub's side — Azure issues a token only when the subject matches exactly.

---

## Integration with ci.yml

Signing lives in a dedicated `sign-windows` job that:
- Runs **only on tag pushes** (`if: startsWith(github.ref, 'refs/tags/v')`)
- Depends on `build-binary` (Windows exe must exist first)
- Re-uploads the signed exe under a distinct artifact name so the unsigned copy is never released

The `release` job depends on `sign-windows` (not directly on `build-binary` for the Windows binary), ensuring the GitHub Release always attaches the signed exe.

```yaml
sign-windows:
  needs: build-binary
  if: startsWith(github.ref, 'refs/tags/v')
  runs-on: windows-latest
  permissions:
    id-token: write
    contents: read
  steps:
    - name: Download Windows binary
      uses: actions/download-artifact@v4
      with:
        name: apra-fleet-win-x64.exe
        path: to-sign

    - name: Azure Login (OIDC)
      uses: azure/login@v2
      with:
        client-id: ${{ secrets.AZURE_CLIENT_ID }}
        tenant-id: ${{ secrets.AZURE_TENANT_ID }}
        subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

    - name: Sign Windows binary
      uses: azure/trusted-signing-action@v0
      with:
        endpoint: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
        trusted-signing-account-name: ${{ secrets.AZURE_SIGNING_ACCOUNT }}
        certificate-profile-name: ${{ secrets.AZURE_CERT_PROFILE }}
        files-folder: to-sign
        files-folder-filter: exe
        file-digest: SHA256
        timestamp-rfc3161: http://timestamp.acs.microsoft.com
        timestamp-digest: SHA256

    - name: Verify signature
      shell: powershell
      run: |
        $sig = Get-AuthenticodeSignature to-sign\apra-fleet-win-x64.exe
        $sig | Select-Object -ExpandProperty SignerCertificate | Format-List
        if ($sig.Status -ne 'Valid') { throw "Signature verification failed: $($sig.Status)" }

    - name: Upload signed binary
      uses: actions/upload-artifact@v4
      with:
        name: apra-fleet-win-x64-signed
        path: to-sign/apra-fleet-win-x64.exe
        retention-days: 30
```

In the `release` job, replace the merged artifact download with explicit per-artifact downloads so the signed Windows binary is used:

```yaml
    - name: Download Linux binary
      uses: actions/download-artifact@v4
      with:
        name: apra-fleet-linux-x64
        path: release-binaries

    - name: Download macOS binary
      uses: actions/download-artifact@v4
      with:
        name: apra-fleet-darwin-arm64
        path: release-binaries

    - name: Download signed Windows binary
      uses: actions/download-artifact@v4
      with:
        name: apra-fleet-win-x64-signed
        path: release-binaries
```

And update `release` job's `needs`:
```yaml
  release:
    needs: [package, sign-windows]
    if: startsWith(github.ref, 'refs/tags/v')
```

---

## Hello-World Test Workflow

Use `.github/workflows/sign-test.yml` to validate the signing pipeline without building apra-fleet.
Trigger: **manual only** (`workflow_dispatch`). Never runs automatically.

See `.github/workflows/sign-test.yml` for the full workflow.

The test:
1. Compiles a 5-line `hello.c` with `gcc` (available on `windows-latest` via MinGW)
2. Signs `hello.exe` using the same Azure secrets and action as production
3. Verifies the signature and exits non-zero if invalid
4. Uploads `hello.exe` as an artifact for inspection

This lets you exhaust signing test iterations against a ~5s build instead of a ~5min apra-fleet build.

---

## Critical Rules

1. **Always timestamp** — certs expire in 72 hours; without a timestamp the signature expires too. Use `http://timestamp.acs.microsoft.com`
2. **Endpoint must match account region** — mismatch causes 403 Forbidden. Store as a secret, not hardcoded
3. **Sign loose binaries before packaging** — if you ever add an installer: sign EXEs/DLLs first, then bundle into the installer, then sign the installer
4. **Tag-only for production signing** — Basic plan is 5,000 signatures/month; don't burn them on dev builds
5. **Verify after signing** — `Get-AuthenticodeSignature` must return `Status: Valid`; make the step exit non-zero if it doesn't

---

## Endpoint Reference

| Region | Endpoint |
|---|---|
| East US | `https://eus.codesigning.azure.net/` |
| West US | `https://wus.codesigning.azure.net/` |
| North Europe | `https://neu.codesigning.azure.net/` |
| West Europe | `https://weu.codesigning.azure.net/` |
