import { useEffect, useState } from "react";
import { Page, SelectField, Table, TextField, type TableColumn } from "@apralabs/apra-fleet-ui-kit";
import {
  deleteCredential,
  listCredentials,
  setCredential,
  setupGitApp,
  updateCredential,
  type CredentialEntry
} from "../api/secrets";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; credentials: CredentialEntry[] };

const columns: Array<TableColumn<CredentialEntry>> = [
  { key: "name", header: "Name" },
  { key: "network_policy", header: "Policy", render: (row) => row.network_policy ?? "-" },
  { key: "members", header: "Members", render: (row) => row.members ?? "-" },
  { key: "expiry", header: "Expiry", render: (row) => row.expiry ?? "-" }
];

interface AddFormState {
  name: string;
  prompt: string;
  networkPolicy: "allow" | "confirm" | "deny";
  members: string;
  ttlSeconds: string;
}

const ADD_FORM_INITIAL: AddFormState = {
  name: "",
  prompt: "",
  networkPolicy: "confirm",
  members: "*",
  ttlSeconds: ""
};

interface UpdateFormState {
  members: string;
  ttlSeconds: string;
  networkPolicy: "allow" | "confirm" | "deny";
}

interface GitAppFormState {
  appId: string;
  privateKeyPath: string;
  installationId: string;
}

const GIT_APP_INITIAL: GitAppFormState = { appId: "", privateKeyPath: "", installationId: "" };

/** S2 screen: stored-credential metadata only (name/policy/members/expiry --
 *  never a value), out-of-band add (DQ-7: opens the collection url in a new
 *  tab), update, delete-behind-confirm and GitHub App setup, each against
 *  its own /api/fleet/ route. */
export function Secrets() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddFormState>(ADD_FORM_INITIAL);
  const [addResult, setAddResult] = useState<{ url: string; expiresAt?: string } | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const [editingName, setEditingName] = useState<string | null>(null);
  const [updateForm, setUpdateForm] = useState<UpdateFormState>({
    members: "",
    ttlSeconds: "",
    networkPolicy: "confirm"
  });
  const [updateError, setUpdateError] = useState<string | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [gitAppOpen, setGitAppOpen] = useState(false);
  const [gitAppForm, setGitAppForm] = useState<GitAppFormState>(GIT_APP_INITIAL);
  const [gitAppResult, setGitAppResult] = useState<string | null>(null);
  const [gitAppError, setGitAppError] = useState<string | null>(null);

  async function load() {
    try {
      const credentials = await listCredentials();
      setState({ kind: "loaded", credentials });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      setState({ kind: "error", message });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleAddSubmit() {
    setAddError(null);
    try {
      const result = await setCredential({
        name: addForm.name,
        prompt: addForm.prompt,
        network_policy: addForm.networkPolicy,
        members: addForm.members,
        ttl_seconds: addForm.ttlSeconds.trim() ? Number(addForm.ttlSeconds) : undefined
      });
      setAddResult(result);
      window.open(result.url, "_blank", "noopener");
      setAddOpen(false);
      setAddForm(ADD_FORM_INITIAL);
      await load();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "unknown error");
    }
  }

  function startUpdate(entry: CredentialEntry) {
    setEditingName(entry.name);
    setUpdateError(null);
    setUpdateForm({
      members: entry.members ?? "",
      ttlSeconds: "",
      networkPolicy: (entry.network_policy as UpdateFormState["networkPolicy"]) ?? "confirm"
    });
  }

  async function submitUpdate() {
    if (!editingName) return;
    setUpdateError(null);
    try {
      await updateCredential({
        name: editingName,
        members: updateForm.members || undefined,
        ttl_seconds: updateForm.ttlSeconds.trim() ? Number(updateForm.ttlSeconds) : undefined,
        network_policy: updateForm.networkPolicy
      });
      setEditingName(null);
      await load();
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : "unknown error");
    }
  }

  async function confirmDelete(name: string) {
    setDeleteError(null);
    try {
      await deleteCredential(name);
      setConfirmingDelete(null);
      await load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "unknown error");
    }
  }

  async function submitGitApp() {
    setGitAppError(null);
    setGitAppResult(null);
    try {
      const result = await setupGitApp({
        app_id: gitAppForm.appId,
        private_key_path: gitAppForm.privateKeyPath,
        installation_id: Number(gitAppForm.installationId)
      });
      setGitAppResult(result.text ?? "");
      setGitAppOpen(false);
      setGitAppForm(GIT_APP_INITIAL);
    } catch (err) {
      setGitAppError(err instanceof Error ? err.message : "unknown error");
    }
  }

  return (
    <Page title="Secrets" subtitle="Stored credentials -- never their values">
      <div style={{ marginBottom: "16px", display: "flex", gap: "8px" }}>
        <button type="button" onClick={() => setAddOpen((v) => !v)}>
          Add credential
        </button>
        <button type="button" onClick={() => setGitAppOpen((v) => !v)}>
          Setup GitHub App
        </button>
      </div>

      {addOpen ? (
        <div>
          <TextField label="Name" name="secretName" value={addForm.name} onChange={(v) => setAddForm((f) => ({ ...f, name: v }))} required />
          <TextField label="Prompt" name="secretPrompt" value={addForm.prompt} onChange={(v) => setAddForm((f) => ({ ...f, prompt: v }))} required />
          <SelectField
            label="Network policy"
            name="secretNetworkPolicy"
            value={addForm.networkPolicy}
            onChange={(v) => setAddForm((f) => ({ ...f, networkPolicy: v as AddFormState["networkPolicy"] }))}
            options={[
              { value: "allow", label: "Allow" },
              { value: "confirm", label: "Confirm" },
              { value: "deny", label: "Deny" }
            ]}
          />
          <TextField label="Members" name="secretMembers" value={addForm.members} onChange={(v) => setAddForm((f) => ({ ...f, members: v }))} />
          <TextField
            label="TTL seconds"
            name="secretTtl"
            type="number"
            value={addForm.ttlSeconds}
            onChange={(v) => setAddForm((f) => ({ ...f, ttlSeconds: v }))}
          />
          <button type="button" onClick={() => void handleAddSubmit()}>
            Submit
          </button>
          {addError ? <p role="alert">{addError}</p> : null}
        </div>
      ) : null}
      {addResult ? <p role="status">Collection url opened: {addResult.url}</p> : null}

      {gitAppOpen ? (
        <div>
          <TextField label="App ID" name="gitAppId" value={gitAppForm.appId} onChange={(v) => setGitAppForm((f) => ({ ...f, appId: v }))} required />
          <TextField
            label="Private key path"
            name="gitAppPrivateKeyPath"
            value={gitAppForm.privateKeyPath}
            onChange={(v) => setGitAppForm((f) => ({ ...f, privateKeyPath: v }))}
            required
          />
          <TextField
            label="Installation ID"
            name="gitAppInstallationId"
            type="number"
            value={gitAppForm.installationId}
            onChange={(v) => setGitAppForm((f) => ({ ...f, installationId: v }))}
            required
          />
          <button type="button" onClick={() => void submitGitApp()}>
            Submit
          </button>
          {gitAppError ? <p role="alert">{gitAppError}</p> : null}
        </div>
      ) : null}
      {gitAppResult ? <p role="status">{gitAppResult}</p> : null}

      {state.kind === "loading" ? <p>Loading credentials...</p> : null}
      {state.kind === "error" ? <p role="alert">Failed to load credentials: {state.message}</p> : null}
      {state.kind === "loaded" ? (
        <>
          <Table
            columns={columns}
            rows={state.credentials}
            rowKey={(row) => row.name}
            emptyMessage="No credentials stored."
          />
          <ul style={{ listStyle: "none", padding: 0 }}>
            {state.credentials.map((entry) => (
              <li key={entry.name} style={{ marginBottom: "12px" }}>
                <strong>{entry.name}</strong>{" "}
                <button type="button" onClick={() => startUpdate(entry)}>
                  Update
                </button>{" "}
                {confirmingDelete === entry.name ? (
                  <>
                    <button type="button" onClick={() => void confirmDelete(entry.name)}>
                      Confirm delete
                    </button>{" "}
                    <button type="button" onClick={() => setConfirmingDelete(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirmingDelete(entry.name)}>
                    Delete
                  </button>
                )}

                {editingName === entry.name ? (
                  <div>
                    <TextField
                      label="Members"
                      name={`update-members-${entry.name}`}
                      value={updateForm.members}
                      onChange={(v) => setUpdateForm((f) => ({ ...f, members: v }))}
                    />
                    <TextField
                      label="TTL seconds"
                      name={`update-ttl-${entry.name}`}
                      type="number"
                      value={updateForm.ttlSeconds}
                      onChange={(v) => setUpdateForm((f) => ({ ...f, ttlSeconds: v }))}
                    />
                    <SelectField
                      label="Network policy"
                      name={`update-policy-${entry.name}`}
                      value={updateForm.networkPolicy}
                      onChange={(v) => setUpdateForm((f) => ({ ...f, networkPolicy: v as UpdateFormState["networkPolicy"] }))}
                      options={[
                        { value: "allow", label: "Allow" },
                        { value: "confirm", label: "Confirm" },
                        { value: "deny", label: "Deny" }
                      ]}
                    />
                    <button type="button" onClick={() => void submitUpdate()}>
                      Save
                    </button>
                    {updateError ? <p role="alert">{updateError}</p> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {deleteError ? <p role="alert">{deleteError}</p> : null}
    </Page>
  );
}
