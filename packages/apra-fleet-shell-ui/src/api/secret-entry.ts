// Thin fetch wrapper over the console-hosted one-time secret-entry API
// (src/console/routes/secret-entry.ts, apra-fleet-i9ag.11.4) for the
// SecretEntry page (apra-fleet-i9ag.11.7). Deliberately its own module --
// members.ts, health.ts and secrets.ts each get their own, so no two lanes
// ever contend for one shared file.
//
// Root-relative paths only (no origin, no configured base) so the same
// bundle works on loopback, a LAN address and a tunnelled port alike: the
// browser reaches this page at the console origin, and a fetch("/api/...")
// always targets that same origin regardless of what host/port it is.

export interface SecretEntryPrompt {
  name: string;
  prompt: string;
}

/** Discriminated outcome of loading the prompt metadata. A 404 is the
 *  EXPECTED "expired or already used" case (the server never distinguishes
 *  unknown/consumed/expired tokens -- see secret-entry.ts's module doc
 *  comment), not an error. */
export type PromptResult =
  | { status: "ok"; prompt: SecretEntryPrompt }
  | { status: "not-found" }
  | { status: "error"; message: string };

/** Discriminated outcome of submitting the value. A 404 here means the
 *  token was consumed or expired between prompt-load and submit; a 422
 *  means the server's onSubmit callback rejected the value (e.g. an empty
 *  or otherwise invalid credential) and the token is still usable for a
 *  retry. */
export type SubmitResult =
  | { status: "ok" }
  | { status: "not-found" }
  | { status: "rejected"; message: string }
  | { status: "error"; message: string };

async function postJson(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
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
  return { status: response.status, data };
}

function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return fallback;
}

export async function fetchSecretEntryPrompt(token: string): Promise<PromptResult> {
  try {
    const { status, data } = await postJson("/api/secret-entry/prompt", { token });
    if (status === 404) return { status: "not-found" };
    if (status < 200 || status >= 300) {
      return { status: "error", message: errorMessage(data, `request failed with status ${status}`) };
    }
    const payload = data as { name?: unknown; prompt?: unknown } | null;
    if (!payload || typeof payload.name !== "string" || typeof payload.prompt !== "string") {
      return { status: "error", message: "malformed response" };
    }
    return { status: "ok", prompt: { name: payload.name, prompt: payload.prompt } };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "network error" };
  }
}

export async function submitSecretEntry(token: string, value: string): Promise<SubmitResult> {
  try {
    const { status, data } = await postJson("/api/secret-entry/submit", { token, value });
    if (status === 404) return { status: "not-found" };
    if (status === 422) return { status: "rejected", message: errorMessage(data, "Submission rejected.") };
    if (status < 200 || status >= 300) {
      return { status: "error", message: errorMessage(data, `request failed with status ${status}`) };
    }
    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "network error" };
  }
}
