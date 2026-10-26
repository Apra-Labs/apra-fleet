export type FleetMemberStatus = 'busy' | 'idle' | 'offline' | 'unknown'

export type FleetMember = {
  id: string
  name: string
  icon: string
  category: string | null
  status: FleetMemberStatus
  quietForS?: number
  reservedBy?: string
}

export type FleetView = {
  /** Server version, absent until the first good read. */
  version?: string
  members: FleetMember[]
  /** Epoch ms of the last read attempt that answered, 0 before any. */
  fetchedAt: number
  /** Why the last read failed, absent when it succeeded. */
  error?: string
}

/** One stored secret as credential_store_list describes it: never its value. */
export type SecretRow = {
  name: string
  /** 'persistent' survives a server restart; 'session' does not. */
  scope: string
  /** '*' or a comma-separated list of member names. */
  members: string
  /** 'none', 'expired', or e.g. '3h 12m remaining'. */
  expiry: string
}

export type SecretsView = {
  items: SecretRow[]
  /** Epoch ms of the last list that answered, 0 before any. */
  fetchedAt: number
  error?: string
}

/**
 * The Secrets section's controls. The secret's value is never held here:
 * 'link' carries only the one-time link to the server's own entry form.
 */
export type SecretForm = {
  mode: 'closed' | 'form' | 'link'
  name: string
  /** '' (all members), '*', or a comma-separated list of member names. */
  members: string
  keep: 'persistent' | 'session'
  ttl: 'none' | '1h' | '1d' | '7d'
  /** The name is an existing secret's: the form replaces its value. */
  replacing?: boolean
  link?: string
  linkExpires?: string
  /** Shown beside the link when it is neither https nor loopback. */
  warning?: string
  /** The secret awaiting a confirm press before it is deleted. */
  confirmDelete?: string
  /** One line about the last action (deleted, failed, ...). */
  note?: string
}

/** The members list's Remove control: which member awaits a confirm, and the last outcome. */
export type MemberAction = {
  /** Name of the member awaiting a confirm press before it is removed. */
  confirmRemove?: string
  /** One line about the last removal (removed, refused as busy or held, ...). */
  note?: string
}

/** What the pane shows: which sections are open, and which show their less-used fields. */
export type PaneLayout = {
  membersOpen: boolean
  secretsOpen: boolean
  /** Members: a state note (quiet time, stall, free, unreachable), holder and short id beside each row. */
  moreMembers: boolean
  /** Secrets: scope, allowed members and expiry beside each row. */
  moreSecrets: boolean
  /** The add/replace form: members, keep and expiry (all members, persistent, never by default). */
  moreOptions: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'fleet-status': { view: FleetView; secrets: SecretsView; secretForm: SecretForm; memberAction: MemberAction; layout: PaneLayout }
  }
}
