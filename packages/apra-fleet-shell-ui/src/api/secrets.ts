// Thin fetch wrapper over the /api/fleet/ console routes the Secrets screen
// (S2) needs. Deliberately its own module (apra-fleet-9h9j.3.1) -- members.ts
// (lane s4-members) and health.ts each get their own, so no two lanes ever
// contend for one shared src/api/fleet.ts file.

/** Whitelisted credential metadata (src/console/routes/fleet.ts
 *  whitelistCredentialEntry) -- the secret VALUE is never part of this
 *  shape, and the server never sends it here. */
export interface CredentialEntry extends Record<string, unknown> {
  name: string;
  scope?: string;
  network_policy?: string;
  members?: string;
  expiry?: string;
  created_at?: string;
}

export interface CredentialCollectionUrl {
  url: string;
  expiresAt?: string;
}

export interface SetCredentialInput {
  name: string;
  prompt: string;
  persist?: boolean;
  network_policy?: "allow" | "confirm" | "deny";
  members?: string;
  ttl_seconds?: number;
}

export interface UpdateCredentialInput {
  name: string;
  members?: string;
  ttl_seconds?: number;
  network_policy?: "allow" | "confirm" | "deny";
}

export interface SetupGitAppInput {
  app_id: string;
  private_key_path: string;
  installation_id: number;
}

export interface ActionResult {
  text: string;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const errorText =
      data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `request failed with status ${response.status}`;
    throw new Error(errorText);
  }
  return (data ?? {}) as T;
}

export async function listCredentials(): Promise<CredentialEntry[]> {
  const data = await postJson<{ credentials: CredentialEntry[] }>("/api/fleet/credential-store-list", {});
  return data.credentials ?? [];
}

export function setCredential(input: SetCredentialInput): Promise<CredentialCollectionUrl> {
  return postJson("/api/fleet/credential-store-set", input);
}

export function updateCredential(input: UpdateCredentialInput): Promise<Record<string, unknown>> {
  return postJson("/api/fleet/credential-store-update", input);
}

export function deleteCredential(name: string): Promise<{ name: string }> {
  return postJson("/api/fleet/credential-store-delete", { name });
}

export function setupGitApp(input: SetupGitAppInput): Promise<ActionResult> {
  return postJson("/api/fleet/setup-git-app", input);
}
