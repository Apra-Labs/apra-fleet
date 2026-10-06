import { useEffect, useState } from "react";
import { Page, SelectField, Table, TextField, type TableColumn } from "@apralabs/apra-fleet-ui-kit";
import {
  deleteCredential,
  listCredentials,
  setCredentialValue,
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
  value: string;
}

const ADD_FORM_INITIAL: AddFormState = { name: "", value: "" };

/** Masked value input with an eye toggle. The toggle only reveals what the
 *  user is typing now -- a stored value is never loaded into this field. */
function SecretValueField({
  name,
  label,
  value,
  onChange
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "8px" }}>
      <TextField
        label={label}
        name={name}
        type={revealed ? "text" : "password"}
        autoComplete="off"
        value={value}
        onChange={onChange}
        required
      />
      <button
        type="button"
        aria-label={revealed ? "Hide value" : "Show value"}
        aria-pressed={revealed}
        onClick={() => setRevealed((v) => !v)}
      >
        {revealed ? "\u{1F648}" : "\u{1F441}"}
      </button>
    </div>
  );
}

interface UpdateFormState {
  value: string;
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
 *  never a value), direct masked-form add and value update (the value is
 *  POSTed to the console and the field cleared; no new tab), metadata update, delete-behind-confirm and GitHub App setup, each against
 *  its own /api/fleet/ route. */
export function Secrets() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddFormState>(ADD_FORM_INITIAL);
  const [addResult, setAddResult] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const [editingName, setEditingName] = useState<string | null>(null);
  const [updateForm, setUpdateForm] = useState<UpdateFormState>({
    value: "",
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
      await setCredentialValue({ name: addForm.name, value: addForm.value });
      setAddResult(`Stored ${addForm.name}`);
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
      value: "",
      members: entry.members ?? "",
      ttlSeconds: "",
      networkPolicy: (entry.network_policy as UpdateFormState["networkPolicy"]) ?? "confirm"
    });
  }

  async function submitUpdate(entry: CredentialEntry) {
    if (!editingName) return;
    setUpdateError(null);
    try {
      if (updateForm.value) {
        // New value replaces the stored one; existing scope/policy/members
        // are carried over so the replacement does not change them.
        await setCredentialValue({
          name: editingName,
          value: updateForm.value,
          persist: entry.scope !== "session",
          network_policy: updateForm.networkPolicy,
          members: updateForm.members || "*",
          ttl_seconds: updateForm.ttlSeconds.trim() ? Number(updateForm.ttlSeconds) : undefined
        });
        setUpdateForm((f) => ({ ...f, value: "" }));
        setEditingName(null);
        await load();
        return;
      }
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
          <SecretValueField label="Value" name="secretValue" value={addForm.value} onChange={(v) => setAddForm((f) => ({ ...f, value: v }))} />
          <button type="button" onClick={() => void handleAddSubmit()}>
            Submit
          </button>
          {addError ? <p role="alert">{addError}</p> : null}
        </div>
      ) : null}
      {addResult ? <p role="status">{addResult}</p> : null}

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
                    <SecretValueField
                      label="New value"
                      name={`update-value-${entry.name}`}
                      value={updateForm.value}
                      onChange={(v) => setUpdateForm((f) => ({ ...f, value: v }))}
                    />
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
                    <button type="button" onClick={() => void submitUpdate(entry)}>
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
