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

declare module 'claude-code' {
  interface PluginState {
    'fleet-status': { view: FleetView }
  }
}
