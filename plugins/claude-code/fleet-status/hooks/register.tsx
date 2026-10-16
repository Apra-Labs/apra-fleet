// fleet-status: apra-fleet at a glance inside Claude Code.
//
// - A status line entry, kept fresh: busy and stalled members by name, the
//   rest counted ("<busy> alice 02:14  <idle> 3  <offline> 1").
// - /fleet-status opens a pane listing every member by category.
//
// Data comes from one read-only MCP tool, apra-fleet's fleet_snapshot, called
// over this session's own connection to the apra-fleet server (so it carries
// whatever credentials that connection has). It is polled every 30s and
// re-read after any other apra-fleet tool call. No writes, no actions: the
// mod calls fleet_snapshot and nothing else.
// Claude Code 2.1.300 puts the call through the permission check like any
// tool call (observed: a prompt per poll without a rule), so it relies on the
// mcp__apra-fleet__* allow rule `apra-fleet install --llm claude` writes. A
// plugin's own hooks never answer for its own calls (the engine skips
// re-entry), so the mod cannot approve itself.
//
// Source is ASCII only: glyphs are written as \u escapes.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FleetMember, FleetMemberStatus, FleetView } from '../types'

const SERVER = 'apra-fleet'
const TOOL_PREFIX = 'mcp__apra-fleet__'
const SNAPSHOT_TOOL = 'fleet_snapshot'
const PANE = 'fleet-status'
const POLL_MS = 30_000
const BUSY_RECHECK_MS = 2_000
const STATUS_NAMES_MAX = 3
const CONNECTING = 'connecting...'
const RETRY_MS = 3_000
// While a read fails this soon after session start the server is presumed
// to be starting: retried every RETRY_MS, shown as CONNECTING.
const STARTUP_MS = 60_000

const view = atom({ plugin: 'fleet-status', key: 'view' } as const, { members: [], fetchedAt: 0 } as FleetView)

const GLYPH: Record<FleetMemberStatus, string> = {
  busy: '\u26A1',
  idle: '\uD83D\uDCA4',
  offline: '\u274C',
  unknown: '\u2753',
}
const COLOR: Record<FleetMemberStatus, string> = {
  busy: 'warning',
  idle: 'success',
  offline: 'error',
  unknown: 'permission',
}
// Needs-attention first.
const PRIORITY: Record<FleetMemberStatus, number> = { unknown: 0, busy: 1, idle: 2, offline: 3 }
const DOT = '\u00B7'
const RULE = '\u2500'

/** 134 -> "02:14", 3725 -> "1:02:05". */
export function clock(s: number): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`
}

function asStatus(raw: unknown): FleetMemberStatus {
  return raw === 'busy' || raw === 'idle' || raw === 'offline' ? raw : 'unknown'
}

/** The fleet_snapshot result text -> members, or throws with a short reason. */
export function parseSnapshot(texts: string[]): { version?: string; members: FleetMember[] } {
  for (const text of texts) {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      continue
    }
    const d = data as { version?: unknown; members?: unknown }
    if (!d || !Array.isArray(d.members)) continue
    const members = d.members.map((raw): FleetMember => {
      const m = raw as Record<string, unknown>
      const member: FleetMember = {
        id: String(m.id ?? ''),
        name: String(m.name ?? m.id ?? '?'),
        icon: typeof m.icon === 'string' ? m.icon : '',
        category: typeof m.category === 'string' && m.category ? m.category : null,
        status: asStatus(m.status),
      }
      if (typeof m.quietForS === 'number' && Number.isFinite(m.quietForS) && m.quietForS >= 0) member.quietForS = Math.round(m.quietForS)
      if (typeof m.reservedBy === 'string' && m.reservedBy) member.reservedBy = m.reservedBy
      return member
    })
    return { version: typeof d.version === 'string' ? d.version : undefined, members }
  }
  throw new Error('unexpected fleet_snapshot reply')
}

function byAttention(a: FleetMember, b: FleetMember): number {
  return PRIORITY[a.status] - PRIORITY[b.status] || a.name.localeCompare(b.name)
}

/** The one-line status entry for a view. */
export function statusLine(v: FleetView): string | undefined {
  if (v.fetchedAt === 0) return undefined
  if (v.error) return v.error
  if (v.members.length === 0) return 'no members'
  const named = v.members.filter(m => m.status === 'busy' || m.status === 'unknown').sort(byAttention)
  const parts = named.slice(0, STATUS_NAMES_MAX).map(m => {
    const t = m.status === 'busy' && m.quietForS !== undefined ? ` ${clock(m.quietForS)}` : ''
    return `${GLYPH[m.status]} ${m.name}${t}`
  })
  if (named.length > STATUS_NAMES_MAX) parts.push(`+${named.length - STATUS_NAMES_MAX}`)
  for (const s of ['idle', 'offline'] as const) {
    const n = v.members.filter(m => m.status === s).length
    if (n > 0) parts.push(`${GLYPH[s]} ${n}`)
  }
  return parts.join('  ')
}

/** Body rows the pane draws for a view: header, counts, rule, groups, footer. */
export function paneRows(v: FleetView): number {
  if (v.members.length === 0) return v.error ? 4 : 3
  const categories = new Set(v.members.map(m => m.category ?? '')).size
  const labelled = categories > 1 || v.members.some(m => m.category !== null)
  return 4 + (v.error ? 1 : 0) + v.members.length + (labelled ? categories * 2 : 0)
}

/** Plain-text summary, the /fleet-status transcript line. */
export function summaryText(v: FleetView): string {
  if (v.error) return v.error
  if (v.members.length === 0) return 'no members registered'
  const count = (s: FleetMemberStatus) => v.members.filter(m => m.status === s).length
  const bits = (['busy', 'unknown', 'idle', 'offline'] as const)
    .filter(s => count(s) > 0)
    .map(s => `${count(s)} ${s}`)
  return `${v.members.length} member${v.members.length === 1 ? '' : 's'}: ${bits.join(', ')}`
}

/**
 * Why a fleet_snapshot read failed, for the status line. Claude Code reports
 * a server that is still starting and one that is down the same way (`no tool
 * "fleet_snapshot" on a server named "apra-fleet"; servers with tools: none`),
 * so time since session start tells them apart; a connected apra-fleet that
 * lacks the tool is an older server.
 */
export function classifyError(text: string, sinceStartMs: number): string {
  const withTools = /servers with tools:\s*(.*)$/i.exec(text)?.[1] ?? ''
  if (withTools.split(/[,\s]+/).includes(SERVER)) return 'server too old: update apra-fleet'
  if (sinceStartMs < STARTUP_MS) return CONNECTING
  return 'server not reachable'
}

let inFlight: Promise<void> | undefined
let startedAt = Date.now()
let poll: { cancel: () => void } | undefined

/** One fleet_snapshot read into the view and the status line; calls overlap into one. */
function refresh($: EngineInterface): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    let fresh: FleetView
    try {
      const res = await $.mcp.call(SERVER, SNAPSHOT_TOOL, {})
      const texts = res.content.flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
      if (res.isError) throw new Error(texts.join(' ') || 'tool error')
      const snap = parseSnapshot(texts)
      fresh = { version: snap.version, members: snap.members, fetchedAt: Date.now() }
    } catch (err) {
      // Keep the last good members: the pane shows them under the error.
      const prev = await read($, view)
      const text = err instanceof Error ? err.message : String(err)
      fresh = { ...prev, fetchedAt: Date.now(), error: classifyError(text, Date.now() - startedAt) }
    }
    await update($, view, () => fresh)
    $.ui.status(statusLine(fresh))
    // Bounded by STARTUP_MS: after it a failure is no longer CONNECTING and
    // reads settle to the 30s poll.
    if (fresh.error === CONNECTING) $.clock.after(RETRY_MS, () => void refresh($))
  })().finally(() => {
    inFlight = undefined
  })
  return inFlight
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fleet-status',
      description: 'Show every apra-fleet member and what it is doing',
    })
    startedAt = Date.now()
    poll?.cancel()
    poll = $.clock.every(POLL_MS, () => void refresh($))
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'fleet-status' }, async $ => {
    await refresh($)
    const v = await read($, view)
    // Inline (above the prompt) the pane asks for the rows its content takes;
    // docked beside the transcript it is floor to ceiling anyway.
    await $.ui.open({ id: PANE, title: 'Fleet', rows: paneRows(v) })
    return { text: summaryText(v) }
  })

  // Any other apra-fleet tool call may change a member's state: re-read
  // shortly after it starts (execute_prompt marks the member busy at
  // dispatch) and again once it settles.
  on('tool.call', { tool: /^mcp__apra-fleet__/ }, async ($, e, next) => {
    if (e.tool === TOOL_PREFIX + SNAPSHOT_TOOL) return next(e)
    const early = $.clock.after(BUSY_RECHECK_MS, () => void refresh($))
    try {
      return await next(e)
    } finally {
      early.cancel()
      void refresh($)
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const v = await read($, view)
    const width = Math.max(20, e.props.bodyColumns ?? 60)
    const rule = <Text dimColor>{RULE.repeat(width)}</Text>
    const asOf = v.fetchedAt ? new Date(v.fetchedAt).toTimeString().slice(0, 8) : '--:--:--'

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold color="claude">apra-fleet</Text>
          {v.version ? <Text dimColor>{`  v${v.version.replace(/^v/, "")}`}</Text> : null}
        </Text>
        <Text dimColor>{`as of ${asOf}`}</Text>
      </Box>
    )

    const hint = v.error === 'server not reachable' ? 'Start it with `apra-fleet start`, then /mcp to reconnect.' : undefined
    if (v.error && v.members.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          {rule}
          <Text color={v.error === CONNECTING ? 'subtle' : 'error'}>{v.error}</Text>
          {hint ? <Text dimColor>{hint}</Text> : null}
        </Box>
      )
    }
    if (v.members.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          {rule}
          <Text dimColor>No members yet. Ask Claude to register one.</Text>
        </Box>
      )
    }

    const counts = (['busy', 'unknown', 'idle', 'offline'] as const)
      .map(s => ({ s, n: v.members.filter(m => m.status === s).length }))
      .filter(c => c.n > 0)
    const groups = new Map<string, FleetMember[]>()
    for (const m of v.members) {
      const key = m.category ?? ''
      groups.set(key, [...(groups.get(key) ?? []), m])
    }
    const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    const nameWidth = Math.min(24, Math.max(...v.members.map(m => m.name.length)) + 2)
    const showCategories = keys.length > 1 || keys[0] !== ''

    return (
      <Box flexDirection="column">
        {header}
        {v.error ? <Text color="error">{`${v.error} -- last known below`}</Text> : null}
        <Box flexDirection="row" gap={2}>
          {counts.map(c => (
            <Text color={COLOR[c.s]}>{`${GLYPH[c.s]} ${c.n} ${c.s}`}</Text>
          ))}
        </Box>
        {rule}
        {keys.map(key => (
          <Box flexDirection="column" marginBottom={showCategories ? 1 : 0}>
            {showCategories ? <Text bold dimColor>{key === '' ? 'uncategorized' : key}</Text> : null}
            {groups.get(key)!.sort(byAttention).map(m => (
              <Box flexDirection="row" paddingLeft={showCategories ? 1 : 0}>
                <Box width={3}><Text>{GLYPH[m.status]}</Text></Box>
                <Box width={3}><Text>{m.icon}</Text></Box>
                <Box width={nameWidth}><Text bold wrap="truncate-end">{m.name}</Text></Box>
                <Box width={9}><Text color={COLOR[m.status]}>{m.status}</Text></Box>
                <Text dimColor wrap="truncate-end">
                  {[
                    m.status === 'busy' && m.quietForS !== undefined ? `quiet ${clock(m.quietForS)}` : '',
                    m.status === 'unknown' ? 'no activity -- may be stalled' : '',
                    m.reservedBy ? `held by ${m.reservedBy}` : '',
                  ].filter(Boolean).join(`  ${DOT}  `)}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
        <Text dimColor>{`refreshes every ${POLL_MS / 1000}s ${DOT} /fleet-status to reopen`}</Text>
      </Box>
    )
  })
}
