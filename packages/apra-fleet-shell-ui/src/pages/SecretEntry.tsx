import { useEffect, useState } from "react";
import { Page, TextField } from "@apralabs/apra-fleet-ui-kit";
import { fetchSecretEntryPrompt, submitSecretEntry, type SecretEntryPrompt } from "../api/secret-entry";

type ViewState =
  | { kind: "loading" }
  | { kind: "not-available" }
  | { kind: "load-error"; message: string }
  | { kind: "ready"; prompt: SecretEntryPrompt }
  | { kind: "submitting"; prompt: SecretEntryPrompt }
  | { kind: "rejected"; prompt: SecretEntryPrompt; message: string }
  | { kind: "success" };

/** Lane i9ag11-shell-entry, streakOrder 1: the page the operator's browser
 *  actually types the secret value into, served from the console origin so
 *  it works wherever /ui works (LAN, an SSH tunnel, a remote install) --
 *  never the server's loopback-bound ephemeral port that was the bug this
 *  lane fixes.
 *
 *  Not yet reachable from the running shell: the next task in this lane
 *  (apra-fleet-i9ag.11.6) wires the #/secret-entry/<token> route in
 *  Nav/App.tsx and renders <SecretEntry token={...} />. */
export function SecretEntry(props: { token: string }) {
  const { token } = props;
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  // The secret value lives only here, in component state, until the POST
  // resolves -- never logged, never put in a URL/hash/title, never written
  // to localStorage or sessionStorage.
  const [value, setValue] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const result = await fetchSecretEntryPrompt(token);
      if (cancelled) return;
      if (result.status === "ok") {
        setState({ kind: "ready", prompt: result.prompt });
      } else if (result.status === "not-found") {
        setState({ kind: "not-available" });
      } else {
        setState({ kind: "load-error", message: result.message });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(prompt: SecretEntryPrompt) {
    // Client-side guard: an empty value must never reach the server. Without
    // this, pressing Submit on an empty field round-trips to
    // POST /api/secret-entry/submit and renders the server's raw zod message
    // ("invalid request body: value: must be a non-empty string") in the
    // retry alert instead of failing fast in the browser.
    if (value.trim().length === 0) return;
    setState({ kind: "submitting", prompt });
    const result = await submitSecretEntry(token, value);
    if (result.status === "ok") {
      // Clear the value as soon as the POST succeeds; the terminal success
      // state below unmounts the input entirely.
      setValue("");
      setState({ kind: "success" });
      return;
    }
    if (result.status === "not-found") {
      setState({ kind: "not-available" });
      return;
    }
    // Both remaining outcomes (server-rejected value, or a network/parse
    // error) render the same "keep the form usable for a retry" state.
    setState({ kind: "rejected", prompt, message: result.message });
  }

  const formState =
    state.kind === "ready" || state.kind === "submitting" || state.kind === "rejected" ? state : null;

  return (
    <Page title="Enter secret" subtitle="Set a secret variable for the fleet">
      {state.kind === "loading" ? <p>Loading...</p> : null}
      {state.kind === "not-available" ? (
        <p role="alert">This entry link has expired or was already used.</p>
      ) : null}
      {state.kind === "load-error" ? <p role="alert">Failed to load: {state.message}</p> : null}
      {state.kind === "success" ? <p role="status">Stored. You can close this tab.</p> : null}

      {formState ? (
        <div>
          <p>
            <strong>{formState.prompt.name}</strong>
          </p>
          <p>{formState.prompt.prompt}</p>
          <p>
            This value is sent to the console over this same connection and is encrypted
            immediately. It is never logged and never leaves this page except in that one
            request.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit(formState.prompt);
            }}
          >
            <TextField
              label="Secret value"
              name="secretEntryValue"
              type="password"
              value={value}
              onChange={setValue}
              required
              autoComplete="off"
              autoFocus
              disabled={formState.kind === "submitting"}
            />
            <button
              type="submit"
              disabled={formState.kind === "submitting" || value.trim().length === 0}
            >
              Submit
            </button>
          </form>
          {formState.kind === "rejected" ? <p role="alert">{formState.message}</p> : null}
        </div>
      ) : null}
    </Page>
  );
}
