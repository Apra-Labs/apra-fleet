import { useState } from "react";
import { Drawer, RadioGroup, SelectField, TextField, Wizard, type WizardStep } from "@apralabs/apra-fleet-ui-kit";
import { registerMember, type RegisterMemberBody } from "../../api/members";

interface WizardFormState {
  memberKind: "local" | "remote";
  host: string;
  port: string;
  username: string;
  authType: "password" | "key";
  password: string;
  keyPath: string;
  friendlyName: string;
  workFolder: string;
  llmProvider: string;
  shell: "" | "gitbash" | "pwsh7" | "powershell5";
}

const INITIAL_STATE: WizardFormState = {
  memberKind: "local",
  host: "",
  port: "22",
  username: "",
  authType: "password",
  password: "",
  keyPath: "",
  friendlyName: "",
  workFolder: "",
  llmProvider: "claude",
  shell: ""
};

function buildRegisterBody(state: WizardFormState): RegisterMemberBody {
  const body: RegisterMemberBody = {
    friendly_name: state.friendlyName,
    work_folder: state.workFolder,
    member_type: state.memberKind,
    llm_provider: state.llmProvider
  };
  if (state.memberKind === "remote") {
    body.host = state.host;
    body.port = Number(state.port) || 22;
    body.username = state.username;
    body.auth_type = state.authType;
    if (state.authType === "password") {
      body.password = state.password;
    } else {
      body.key_path = state.keyPath;
    }
  }
  if (state.shell) {
    body.shell = state.shell;
  }
  return body;
}

interface AddMemberWizardProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful register_member call so the caller can
   *  refresh the member list. */
  onRegistered: () => void;
}

/** S1/W1 add-member wizard: local vs SSH remote, remote connection details,
 *  work folder/shell/provider, then submit. Required-field validation is
 *  client-side and blocks the step transition; a server error is shown on
 *  the final step without discarding any entered input (the form state
 *  lives here, untouched by the Wizard primitive itself). */
export function AddMemberWizard({ open, onClose, onRegistered }: AddMemberWizardProps) {
  const [state, setState] = useState<WizardFormState>(INITIAL_STATE);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof WizardFormState>(key: K, value: WizardFormState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  function handleClose() {
    setState(INITIAL_STATE);
    setSubmitError(null);
    onClose();
  }

  async function handleSubmit() {
    setSubmitError(null);
    setSubmitting(true);
    try {
      await registerMember(buildRegisterBody(state));
      setSubmitting(false);
      setState(INITIAL_STATE);
      onRegistered();
      onClose();
    } catch (err) {
      setSubmitting(false);
      setSubmitError(err instanceof Error ? err.message : "unknown error");
    }
  }

  const steps: WizardStep[] = [
    {
      key: "kind",
      title: "Member type",
      content: (
        <RadioGroup
          label="Member type"
          name="memberKind"
          value={state.memberKind}
          onChange={(value) => update("memberKind", value as WizardFormState["memberKind"])}
          options={[
            { value: "local", label: "Local" },
            { value: "remote", label: "SSH remote" }
          ]}
        />
      )
    }
  ];

  if (state.memberKind === "remote") {
    steps.push({
      key: "remote",
      title: "Connection",
      content: (
        <>
          <TextField label="Host" name="host" value={state.host} onChange={(v) => update("host", v)} required />
          <TextField label="Port" name="port" type="number" value={state.port} onChange={(v) => update("port", v)} />
          <TextField
            label="Username"
            name="username"
            value={state.username}
            onChange={(v) => update("username", v)}
            required
          />
          <RadioGroup
            label="Auth method"
            name="authType"
            value={state.authType}
            onChange={(value) => update("authType", value as WizardFormState["authType"])}
            options={[
              { value: "password", label: "Password" },
              { value: "key", label: "SSH key" }
            ]}
          />
          {state.authType === "password" ? (
            <TextField
              label="Password"
              name="password"
              type="password"
              value={state.password}
              onChange={(v) => update("password", v)}
              required
            />
          ) : (
            <TextField
              label="Key path"
              name="keyPath"
              value={state.keyPath}
              onChange={(v) => update("keyPath", v)}
              required
            />
          )}
        </>
      ),
      validate: () => {
        if (!state.host.trim()) return "Host is required";
        if (!state.username.trim()) return "Username is required";
        if (state.authType === "password" && !state.password.trim()) return "Password is required";
        if (state.authType === "key" && !state.keyPath.trim()) return "Key path is required";
        return null;
      }
    });
  }

  steps.push({
    key: "details",
    title: "Details",
    content: (
      <>
        <TextField
          label="Friendly name"
          name="friendlyName"
          value={state.friendlyName}
          onChange={(v) => update("friendlyName", v)}
          required
        />
        <TextField
          label="Work folder"
          name="workFolder"
          value={state.workFolder}
          onChange={(v) => update("workFolder", v)}
          required
        />
        <SelectField
          label="LLM provider"
          name="llmProvider"
          value={state.llmProvider}
          onChange={(v) => update("llmProvider", v)}
          options={[
            { value: "claude", label: "Claude" },
            { value: "codex", label: "Codex" },
            { value: "copilot", label: "Copilot" },
            { value: "agy", label: "Agy" },
            { value: "opencode", label: "Opencode" },
            { value: "none", label: "None" }
          ]}
        />
        <SelectField
          label="Windows shell"
          name="shell"
          value={state.shell}
          onChange={(v) => update("shell", v as WizardFormState["shell"])}
          options={[
            { value: "", label: "(default)" },
            { value: "gitbash", label: "Git Bash" },
            { value: "pwsh7", label: "PowerShell 7" },
            { value: "powershell5", label: "PowerShell 5" }
          ]}
        />
      </>
    ),
    validate: () => {
      if (!state.friendlyName.trim()) return "Friendly name is required";
      if (!state.workFolder.trim()) return "Work folder is required";
      return null;
    }
  });

  steps.push({
    key: "review",
    title: "Review",
    content: (
      <p>
        {submitting
          ? "Registering member..."
          : `Ready to register ${state.friendlyName || "this member"} (${state.memberKind}).`}
      </p>
    )
  });

  return (
    <Drawer open={open} title="Add member" onClose={handleClose}>
      <Wizard steps={steps} onSubmit={() => void handleSubmit()} submitLabel="Register" submitError={submitError} />
    </Drawer>
  );
}
