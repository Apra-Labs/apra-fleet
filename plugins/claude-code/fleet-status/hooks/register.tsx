// fleet-status: apra-fleet at a glance inside Claude Code.
//
// - A status line entry, kept fresh: busy and stalled members by name, the
//   rest counted ("<busy> alice 02:14  <idle> 3  <offline> 1").
// - /fleet-status opens a pane listing every member by category, each with
//   a Remove control (remove_member after a confirm press; never forced, so
//   the server still refuses a busy or held member).
// - A Secrets section in the pane: list, add or replace, and delete the
//   secrets in apra-fleet's credential store.
//
// Data comes from apra-fleet's MCP tools, called over this session's own
// connection to the apra-fleet server (so it carries whatever credentials
// that connection has): fleet_snapshot and credential_store_list, polled
// every 30s and re-read after any other apra-fleet tool call.
//
// A secret's VALUE never passes through this mod, Claude Code or the model.
// Adding one asks the server (credential_store_set with return_url) for a
// one-time link to its own entry form, where the value is typed into a
// masked field and goes from the browser straight to the server; or the
// person runs `apra-fleet secret --set` in another terminal, which prompts
// with input hidden. The mod only ever sends names and settings, and only
// ever holds the link. Claude Code's own Input is never used for a value:
// it has no masking and other plugins' ui.input hooks would see the text.
// Claude Code 2.1.300 puts the call through the permission check like any
// tool call (observed: a prompt per poll without a rule), so it relies on the
// mcp__apra-fleet__* allow rule `apra-fleet install --llm claude` writes. A
// plugin's own hooks never answer for its own calls (the engine skips
// re-entry), so the mod cannot approve itself.
//
// Source is ASCII only: glyphs are written as \u escapes.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, UiPressArgument } from 'claude-code'

import type { FleetMember, FleetMemberStatus, FleetView, MemberAction, PaneLayout, SecretForm, SecretRow, SecretsView } from '../types'

const SERVER = 'apra-fleet'
const TOOL_PREFIX = 'mcp__apra-fleet__'
const SNAPSHOT_TOOL = 'fleet_snapshot'
const PANE = 'fleet-status'
const POLL_MS = 30_000
const BUSY_RECHECK_MS = 2_000
const STATUS_NAMES_MAX = 3
const CONNECTING = 'connecting...'
const UNREACHABLE = 'server not reachable'
const RETRY_MS = 3_000
// While a read fails this soon after session start the server is presumed
// to be starting: retried every RETRY_MS, shown as CONNECTING.
const STARTUP_MS = 60_000

const LIST_TOOL = 'credential_store_list'
const SET_TOOL = 'credential_store_set'
const UPDATE_TOOL = 'credential_store_update'
const DELETE_TOOL = 'credential_store_delete'
const REMOVE_TOOL = 'remove_member'
const SECRET_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const KEY = '\uD83D\uDD11'

const view = atom({ plugin: 'fleet-status', key: 'view' } as const, { members: [], fetchedAt: 0 } as FleetView)
const secrets = atom({ plugin: 'fleet-status', key: 'secrets' } as const, { items: [], fetchedAt: 0 } as SecretsView)
const CLOSED_FORM: SecretForm = { mode: 'closed', name: '', members: '', keep: 'persistent', ttl: 'none' }
const secretForm = atom({ plugin: 'fleet-status', key: 'secretForm' } as const, CLOSED_FORM)
// Members open, secrets folded; the less-used fields behind "more". Kept
// across sessions in $.store.
export const DEFAULT_LAYOUT: PaneLayout = { membersOpen: true, secretsOpen: false, moreMembers: false, moreSecrets: false, moreOptions: false }
const LAYOUT_KEY = 'layout'
const layout = atom({ plugin: 'fleet-status', key: 'layout' } as const, DEFAULT_LAYOUT)
const memberAction = atom({ plugin: 'fleet-status', key: 'memberAction' } as const, {} as MemberAction)

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
// One-glyph remove/delete control: a narrow x, one column wide on every
// terminal (the wastebasket emoji's width varies and would break columns).
const CROSS = '\u2715'
const OPEN = '\u25BE'
const CLOSED = '\u25B8'
const MORE = '\u2026'

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

/** The fleet line with the secrets part appended when there is one. */
export function withSecrets(line: string | undefined, s: SecretsView): string | undefined {
  const extra = secretsStatus(s)
  if (!extra) return line
  return line ? `${line}  ${extra}` : extra
}

/**
 * Body rows the pane draws for the members part: title, rule, section header,
 * the error line, then (open) a label per category and a row per member, or
 * the empty/error lines; and the footer.
 */
export function paneRows(v: FleetView, l: PaneLayout = DEFAULT_LAYOUT): number {
  const fixed = 4
  if (!l.membersOpen) return fixed + (v.error && v.members.length > 0 ? 1 : 0)
  if (v.members.length === 0) return fixed + 1 + (v.error?.startsWith(UNREACHABLE) ? 1 : 0)
  const categories = new Set(v.members.map(m => m.category ?? '')).size
  const labelled = categories > 1 || v.members.some(m => m.category !== null)
  return fixed + (v.error ? 1 : 0) + v.members.length + (labelled ? categories : 0)
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
  // Newer wording: the server's tools are not in this session at all -- down,
  // or hidden by a permissions.deny rule.
  const hidden = HIDDEN_TOOL.exec(text)?.[1]
  if (hidden) return `${UNREACHABLE} (or ${TOOL_PREFIX}${hidden} denied)`
  return UNREACHABLE
}

/**
 * The `no connected MCP tool "X"` wording Claude Code uses when a tool is not
 * in this session: the server is down, or a permissions.deny rule hides it.
 */
const HIDDEN_TOOL = /no connected MCP tool "([\w-]+)"/

/**
 * A failed $.mcp.call -> the line the pane shows. When fleet_snapshot still
 * answers, the server is up, so a tool it says is missing is hidden from this
 * session (a permissions.deny rule): say so, rather than echo the raw error.
 */
export function callErrorText(text: string, snapshotOk: boolean): string {
  const tool = HIDDEN_TOOL.exec(text)?.[1]
  if (tool && snapshotOk) {
    const what = tool.startsWith('credential_store_') ? 'credential tools' : tool
    return `${what} hidden in this session (permission deny rule ${TOOL_PREFIX}${tool}?)`
  }
  return text.replace(/^\$\.mcp\.call:\s*/, '')
}

async function errorText($: EngineInterface, err: unknown): Promise<string> {
  const v = await read($, view)
  return callErrorText(err instanceof Error ? err.message : String(err), v.fetchedAt > 0 && !v.error)
}


// --- Secrets ---------------------------------------------------------------

const TTL_SECONDS: Record<SecretForm['ttl'], number | undefined> = { none: undefined, '1h': 3600, '1d': 86400, '7d': 604800 }

function texts(res: { content: Array<{ type: string; text?: unknown }> }): string[] {
  return res.content.flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
}

/** credential_store_list's reply -> rows (names and settings only; it never carries a value). */
export function parseSecrets(replies: string[]): SecretRow[] {
  for (const text of replies) {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      continue
    }
    if (!Array.isArray(data)) continue
    return data.map((raw): SecretRow => {
      const r = raw as Record<string, unknown>
      return {
        name: String(r.name ?? '?'),
        scope: String(r.scope ?? ''),
        members: String(r.members ?? '*'),
        expiry: String(r.expiry ?? 'none'),
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
  }
  throw new Error('unexpected credential_store_list reply')
}

/** Expired, or due within the hour ("12m 3s remaining": no hours left). */
export function expiresSoon(row: SecretRow): boolean {
  if (row.expiry === 'expired') return true
  return row.expiry.endsWith('remaining') && !/\dh\b/.test(row.expiry)
}

/** credential_store_list's expiry, compact for the pane: "167h 59m remaining" -> "6d left". */
export function expiryLabel(expiry: string): string {
  if (expiry === 'none') return 'no expiry'
  const hm = /^(\d+)h (\d+)m remaining$/.exec(expiry)
  if (hm) {
    const h = Number(hm[1])
    return h >= 48 ? `${Math.floor(h / 24)}d left` : `${h}h ${hm[2]}m left`
  }
  const m = /^(\d+)m \d+s remaining$/.exec(expiry)
  if (m) return `${m[1]}m left`
  return expiry.replace(/ remaining$/, ' left')
}

/** The status line's secrets part: only when some secret needs attention. */
export function secretsStatus(s: SecretsView): string | undefined {
  const n = s.items.filter(expiresSoon).length
  return n > 0 ? `${KEY} ${n} expiring` : undefined
}

/**
 * Why an entry link is unsafe to open as given, or undefined when it is fine:
 * https, or a loopback address (the value never leaves this machine).
 */
export function entryLinkWarning(link: string): string | undefined {
  let u: URL
  try {
    u = new URL(link)
  } catch {
    return 'not a link this mod can check'
  }
  if (u.protocol === 'https:') return undefined
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return undefined
  return `plain http to ${u.host}: the value would cross the network unencrypted. Use an SSH tunnel or https, or the terminal command.`
}

/**
 * credential_store_set's return_url reply -> the link and its expiry, or a
 * failure line. The server sends both a text block and structuredContent
 * ({ absoluteUrl, expiresAt }); Claude Code 2.1.301 hands a plugin the
 * structured form as the only text block, so JSON is read first.
 * A server without return_url (0.4.x) ignores it and collects the value out of
 * band itself (a hidden-input terminal); its "NAME stored" reply is `stored`.
 */
export function parseEntryLink(replies: string[], structured?: unknown): { link: string; expires?: string } | { stored: true } | { error: string } {
  const fromJson = (d: unknown) => {
    const o = d as { absoluteUrl?: unknown; url?: unknown; expiresAt?: unknown } | null
    const link = typeof o?.absoluteUrl === 'string' ? o.absoluteUrl : typeof o?.url === 'string' && /^https?:/.test(o.url) ? o.url : undefined
    if (!link) return undefined
    return typeof o?.expiresAt === 'string' ? { link, expires: o.expiresAt } : { link }
  }
  const s = fromJson(structured)
  if (s) return s
  for (const text of replies) {
    try {
      const j = fromJson(JSON.parse(text))
      if (j) return j
    } catch {
      // not JSON: the human-readable reply, read below
    }
  }
  const all = replies.join('\n')
  if (/^\s*\[FAIL\]/.test(all)) return { error: all.trim().split('\n')[0]!.replace(/^\s*\[FAIL\]\s*/, '') }
  const link = /(https?:\/\/[^\s"'<>]+)/.exec(all)?.[1]
  if (!link && /^\W*[\w-]+ stored\b/m.test(all)) return { stored: true }
  if (!link) return { error: 'the server did not return an entry link' }
  const expires = /\(expires ([^)]+)\)/.exec(all)?.[1]
  return expires ? { link, expires } : { link }
}

// --- Removing a member ------------------------------------------------------

/**
 * remove_member's reply -> the note line. The server refuses a busy or held
 * member unless forced; the pane never forces, it shows the refusal.
 */
export function removeNote(name: string, replies: string[], isError?: boolean): string {
  const first = replies.join('\n').trim().split('\n')[0] ?? ''
  if (!isError && /has been removed/.test(first)) return `Removed ${name}.`
  const why = first.replace(/^\W+/, '').replace(/\s*(or\s+)?set force=true.*$/i, '').replace(/\s*Error code: [\w-]+\.?/, '')
    .replace(/^Cannot remove member "[^"]*":\s*/, '')
  return `Not removed: ${why || 'no reply from the server'}`
}

async function removeMember($: EngineInterface, name: string): Promise<void> {
  let note: string
  try {
    const res = await $.mcp.call(SERVER, REMOVE_TOOL, { member_name: name })
    note = removeNote(name, texts(res), res.isError)
  } catch (err) {
    note = `Not removed: ${await errorText($, err)}`
  }
  await update($, memberAction, () => ({ note }))
  await refresh($)
}

/** Rows the remove confirm and its outcome take under the member list. */
export function memberActionRows(a: MemberAction): number {
  return (a.confirmRemove ? 1 : 0) + (a.note ? 1 : 0)
}

/** The command that stores a value from another terminal, its input hidden. */
export function cliCommand(name: string): string {
  return `apra-fleet secret --set ${name} --persist`
}

let secretsInFlight: Promise<void> | undefined

/** One credential_store_list read into the secrets view. */
function refreshSecrets($: EngineInterface): Promise<void> {
  if (secretsInFlight) return secretsInFlight
  secretsInFlight = (async () => {
    let fresh: SecretsView
    try {
      const res = await $.mcp.call(SERVER, LIST_TOOL, {})
      if (res.isError) throw new Error(texts(res).join(' ') || 'tool error')
      fresh = { items: parseSecrets(texts(res)), fetchedAt: Date.now() }
    } catch (err) {
      const prev = await read($, secrets)
      fresh = { ...prev, fetchedAt: Date.now(), error: await errorText($, err) }
    }
    await update($, secrets, () => fresh)
    // A delete or apply changes the expiring count: keep the status line in step.
    const v = await read($, view)
    if (v.fetchedAt) $.ui.status(withSecrets(statusLine(v), fresh))
  })().finally(() => {
    secretsInFlight = undefined
  })
  return secretsInFlight
}

async function setNote($: EngineInterface, note: string | undefined): Promise<void> {
  await update($, secretForm, f => ({ ...f, note }))
}

/** Ask the server for a one-time entry link; the value is typed on its form, never here. */
async function requestEntryLink($: EngineInterface): Promise<void> {
  const f = await read($, secretForm)
  if (!SECRET_NAME.test(f.name)) return setNote($, 'Name: letters, digits, _ and -, up to 64 characters.')
  const args: Record<string, unknown> = {
    name: f.name,
    prompt: `Value for ${f.name}`,
    persist: f.keep === 'persistent',
    members: f.members.trim() || '*',
    return_url: true,
  }
  const ttl = TTL_SECONDS[f.ttl]
  if (ttl !== undefined) args.ttl_seconds = ttl
  await setNote($, 'Asking the server for a secure entry\u2026')
  try {
    const res = await $.mcp.call(SERVER, SET_TOOL, args)
    const got = parseEntryLink(texts(res), res.structuredContent)
    if ('stored' in got) {
      await update($, secretForm, () => ({ ...CLOSED_FORM, note: `${f.name} stored.` }))
      return refreshSecrets($)
    }
    if ('error' in got) return setNote($, `No browser link from this server; use the command above. (${got.error})`)
    await update($, secretForm, cur => ({
      ...cur,
      mode: 'link' as const,
      link: got.link,
      linkExpires: got.expires && !Number.isNaN(Date.parse(got.expires)) ? new Date(got.expires).toTimeString().slice(0, 5) : got.expires,
      warning: entryLinkWarning(got.link),
      note: undefined,
    }))
  } catch (err) {
    await setNote($, `No link: ${await errorText($, err)}`)
  }
}

/** After `apra-fleet secret --set`: apply the members and expiry picked here (settings only). */
async function applySettings($: EngineInterface): Promise<void> {
  const f = await read($, secretForm)
  const args: Record<string, unknown> = { name: f.name, members: f.members.trim() || '*' }
  const ttl = TTL_SECONDS[f.ttl]
  if (ttl !== undefined) args.ttl_seconds = ttl
  try {
    const res = await $.mcp.call(SERVER, UPDATE_TOOL, args)
    const line = texts(res).join(' ').trim()
    await setNote($, res.isError || /not found/i.test(line) ? `Not applied: ${line || 'no such secret yet'}` : `Settings applied to ${f.name}.`)
  } catch (err) {
    await setNote($, `Not applied: ${await errorText($, err)}`)
  }
  await refreshSecrets($)
}

async function deleteSecret($: EngineInterface, name: string): Promise<void> {
  try {
    const res = await $.mcp.call(SERVER, DELETE_TOOL, { name })
    const line = texts(res).join(' ')
    await update($, secretForm, f => ({
      ...f,
      confirmDelete: undefined,
      note: res.isError || /not found/i.test(line) ? `Could not delete ${name}.` : `Deleted ${name}.`,
    }))
  } catch (err) {
    const why = await errorText($, err)
    await update($, secretForm, f => ({ ...f, confirmDelete: undefined, note: `Could not delete ${name}: ${why}` }))
  }
  await refreshSecrets($)
}

/** Rows the Secrets section takes in the pane: rule and header, then (open) the list, confirm, form and note. */
export function secretsRows(s: SecretsView, f: SecretForm, l: PaneLayout = DEFAULT_LAYOUT): number {
  if (!l.secretsOpen) return 2
  // With an error the empty-state line is not drawn: the error stands alone.
  const list = s.error ? 1 + s.items.length : Math.max(1, s.items.length)
  const form = f.mode === 'form' ? 4 + (l.moreOptions ? 3 : 0) : f.mode === 'link' ? 3 + (f.warning ? 1 : 0) : 0
  return 2 + list + form + (f.note ? 1 : 0) + (f.confirmDelete ? 1 : 0)
}

/** The token the fleet resolves to a secret's value inside a member-bound command. */
export function secretToken(name: string): string {
  return `{{secret.${name}}}`
}

// --- Pane size ---------------------------------------------------------------

/**
 * Cells kept free at the body's right edge. The terminal surface does not
 * draw the last two body columns (observed: every row, the rule included),
 * so the tree is laid out that much narrower and right-aligned controls
 * (x, more, less, add) land in cells that show.
 */
export const GUTTER = 2
const MIN_COLUMNS = 40
const MAX_COLUMNS = 72
// Member row: status glyph, icon and state columns, the x control.
const MEMBER_FIXED = 3 + 3 + 9 + 1
export const FOOTER = `refresh ${POLL_MS / 1000}s ${DOT} press name to insert token`

/** Terminal cells a string takes: astral and the status emoji are two wide. */
export function cells(text: string): number {
  let n = 0
  for (const ch of text) n += ch.codePointAt(0)! >= 0x1f000 || ch === GLYPH.busy || ch === GLYPH.offline || ch === GLYPH.unknown ? 2 : 1
  return n
}

/** What a member row shows behind "more": always something, whatever the state. */
export function memberExtras(m: FleetMember): string {
  const bits = [
    m.status === 'busy' ? (m.quietForS !== undefined ? `quiet ${clock(m.quietForS)}` : 'working') : '',
    m.status === 'unknown' ? 'no activity -- may be stalled' : '',
    m.status === 'idle' && !m.reservedBy ? 'free for work' : '',
    m.status === 'offline' ? 'not reachable' : '',
    m.reservedBy ? `held by ${m.reservedBy}` : '',
    m.id && m.id !== m.name ? `id ${m.id.slice(0, 8)}` : '',
  ]
  return bits.filter(Boolean).join(`  ${DOT}  `)
}

/** The widest member name the row can give its full length, at `width` body cells. */
export function nameCap(width: number, indent: number): number {
  return Math.max(10, width - MEMBER_FIXED - indent)
}

function counted(v: FleetView): Array<{ s: FleetMemberStatus; n: number }> {
  return (['busy', 'unknown', 'idle', 'offline'] as const)
    .map(c => ({ s: c, n: v.members.filter(m => m.status === c).length }))
    .filter(c => c.n > 0)
}

/**
 * Body columns the pane's content takes (header, section headers, member and
 * secret rows, the open form, the footer), clamped to 40-72, plus GUTTER.
 */
export function paneColumns(v: FleetView, s: SecretsView, l: PaneLayout = DEFAULT_LAYOUT, f: SecretForm = CLOSED_FORM): number {
  const widths: number[] = [cells(FOOTER)]
  widths.push(10 + (v.version ? 3 + v.version.replace(/^v/, '').length : 0) + 2 + 14)
  const summary = counted(v).reduce((w, c, i) => w + cells(`${GLYPH[c.s]} ${c.n}`) + (i ? 2 : 0), 0)
  widths.push(cells(`${OPEN} Members ${v.members.length}`) + (summary ? 2 + summary : 0) + 2 + 5)
  if (l.membersOpen && v.members.length > 0) {
    const indent = new Set(v.members.map(m => m.category ?? '')).size > 1 || v.members.some(m => m.category !== null) ? 1 : 0
    const name = Math.max(...v.members.map(m => m.name.length)) + 2
    for (const m of v.members) {
      const extra = l.moreMembers ? cells(memberExtras(m)) + 1 : 0
      widths.push(indent + MEMBER_FIXED + name + extra)
    }
  }
  const expiring = s.items.filter(expiresSoon).length
  widths.push(cells(`${OPEN} ${KEY} Secrets ${s.items.length}`) + (expiring ? 2 + cells(`${expiring} expiring`) : 0) + 2 + (s.items.length ? 7 : 0) + 3)
  if (l.secretsOpen) {
    const name = Math.min(28, Math.max(0, ...s.items.map(r => r.name.length)) + 2)
    for (const r of s.items) {
      const expiry = l.moreSecrets || expiresSoon(r) ? cells(expiryLabel(r.expiry)) : 0
      widths.push(name + (l.moreSecrets ? 28 : 0) + expiry + 1 + 'replace'.length + 2)
    }
    if (f.mode === 'form') {
      widths.push(1 + cliCommand(f.name || '<NAME>').length + 1 + 6)
      widths.push(1 + (l.moreOptions ? 27 : 0) + 19 + 1 + (l.moreOptions ? 13 : 14) + 1 + 7)
    }
  }
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, ...widths)) + GUTTER
}

/** Open (or resize) the pane to what its content takes now. */
async function openPane($: EngineInterface): Promise<void> {
  const v = await read($, view)
  const l = await read($, layout)
  const s = await read($, secrets)
  const f = await read($, secretForm)
  // Inline (above the prompt) the pane asks for the rows its content takes;
  // docked beside the transcript, for the columns.
  const rows = paneRows(v, l) + (l.membersOpen ? memberActionRows(await read($, memberAction)) : 0) + secretsRows(s, f, l)
  await $.ui.open({ id: PANE, title: 'Fleet', rows, columns: paneColumns(v, s, l, f) })
}

async function setLayout($: EngineInterface, patch: Partial<PaneLayout>): Promise<void> {
  const next = await update($, layout, cur => ({ ...cur, ...patch }))
  // Remembering the layout is a convenience: a store that refuses must not undo the toggle.
  await $.store.set(LAYOUT_KEY, next).catch(() => undefined)
  // A toggle is a press inside the open pane: re-ask its size for the new content.
  await openPane($).catch(() => undefined)
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
    await refreshSecrets($)
    $.ui.status(withSecrets(statusLine(fresh), await read($, secrets)))
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
    const saved = (await $.store.get(LAYOUT_KEY)) as Partial<PaneLayout> | undefined
    if (saved && typeof saved === 'object') await update($, layout, () => ({ ...DEFAULT_LAYOUT, ...saved }))
    poll?.cancel()
    poll = $.clock.every(POLL_MS, () => void refresh($))
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'fleet-status' }, async $ => {
    await refresh($)
    await openPane($)
    return { text: summaryText(await read($, view)) }
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
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Link } = ui
    // Mobile draws no Input or Select: the form then shows its values as text.
    const Input = 'Input' in ui ? ui.Input : undefined
    const Select = 'Select' in ui ? ui.Select : undefined
    const v = await read($, view)
    const act = await read($, memberAction)
    const s = await read($, secrets)
    const f = await read($, secretForm)
    // GUTTER: the last body cells do not show on the terminal; lay out short of them.
    const width = Math.max(20, (e.props.bodyColumns ?? 60) - GUTTER)
    const rule = <Text dimColor>{RULE.repeat(width)}</Text>
    const asOf = v.fetchedAt ? new Date(v.fetchedAt).toTimeString().slice(0, 8) : '--:--:--'
    const copy = (text: string) => (p: UiPressArgument) => void $.ui.copy({ text, surface: p.surface })
    const setForm = (fn: (cur: SecretForm) => SecretForm) => void update($, secretForm, fn)

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold color="claude">apra-fleet</Text>
          {v.version ? <Text dimColor>{`  v${v.version.replace(/^v/, "")}`}</Text> : null}
        </Text>
        <Text dimColor>{`as of ${asOf}`}</Text>
      </Box>
    )

    const l = await read($, layout)
    const toggle = (patch: Partial<PaneLayout>) => () => void setLayout($, patch)
    // A section header: the fold control, a summary, then the section's own controls.
    const sectionHeader = (key: string, open: boolean, title: string, summary: RenderChildren, controls: RenderChildren) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={2}>
          <Button key={key} label={`${open ? OPEN : CLOSED} ${title}`} plain onPress={toggle(key === 'fold-members' ? { membersOpen: !open } : { secretsOpen: !open })} />
          {summary}
        </Box>
        <Box flexDirection="row" gap={2}>{controls}</Box>
      </Box>
    )
    const moreButton = (key: string, shown: boolean, patch: Partial<PaneLayout>) => (
      <Button key={key} label={shown ? 'less' : `more${MORE}`} plain dimColor onPress={toggle(patch)} />
    )

    // --- Members ---
    const counts = counted(v)
    const memberSummary = (
      <Box flexDirection="row" gap={2}>
        {counts.map(c => (
          <Text color={COLOR[c.s]}>{`${GLYPH[c.s]} ${c.n}`}</Text>
        ))}
      </Box>
    )
    let memberBody
    const hint = v.error?.startsWith(UNREACHABLE) ? 'Start it with `apra-fleet start`, then /mcp to reconnect.' : undefined
    if (v.error && v.members.length === 0) {
      memberBody = (
        <Box flexDirection="column">
          <Text color={v.error === CONNECTING ? 'subtle' : 'error'}>{v.error}</Text>
          {hint ? <Text dimColor>{hint}</Text> : null}
        </Box>
      )
    } else if (v.members.length === 0) {
      memberBody = <Text dimColor>No members yet. Ask Claude to register one.</Text>
    } else {
      const groups = new Map<string, FleetMember[]>()
      for (const m of v.members) {
        const key = m.category ?? ''
        groups.set(key, [...(groups.get(key) ?? []), m])
      }
      const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
      const showCategories = keys.length > 1 || keys[0] !== ''
      // The cap is what the row leaves after its fixed columns, not a constant.
      const nameWidth = Math.min(nameCap(width, showCategories ? 1 : 0), Math.max(...v.members.map(m => m.name.length)) + 2)
      memberBody = (
        <Box flexDirection="column">
          {keys.map(key => (
            <Box flexDirection="column">
              {showCategories ? <Text bold dimColor>{key === '' ? 'uncategorized' : key}</Text> : null}
              {groups.get(key)!.sort(byAttention).map(m => (
                <Box flexDirection="row" paddingLeft={showCategories ? 1 : 0}>
                  <Box width={3}><Text>{GLYPH[m.status]}</Text></Box>
                  <Box width={3}><Text>{m.icon}</Text></Box>
                  <Box width={nameWidth}><Text bold wrap="truncate-end">{m.name}</Text></Box>
                  <Box width={9}><Text color={COLOR[m.status]}>{m.status}</Text></Box>
                  <Box flexGrow={1}>
                    {l.moreMembers ? <Text dimColor wrap="truncate-end">{memberExtras(m)}</Text> : null}
                  </Box>
                  <Button key={`remove:${m.name}`} label={CROSS} plain dimColor
                    onPress={() => void update($, memberAction, () => ({ confirmRemove: m.name }))} />
                </Box>
              ))}
            </Box>
          ))}
          {act.confirmRemove ? (
            <Box flexDirection="row" gap={1}>
              <Text color="warning">{`Remove ${act.confirmRemove} from the fleet?`}</Text>
              <Button key="remove-confirm" label="Remove" variant="primary"
                onPress={() => void removeMember($, act.confirmRemove!)} />
              <Button key="remove-cancel" label="Cancel" onPress={() => void update($, memberAction, () => ({}))} />
            </Box>
          ) : null}
          {act.note ? <Text color={act.note.startsWith('Removed') ? 'success' : 'error'}>{act.note}</Text> : null}
        </Box>
      )
    }
    const membersBlock = (
      <Box flexDirection="column">
        {rule}
        {sectionHeader('fold-members', l.membersOpen, `Members ${v.members.length}`, memberSummary,
          l.membersOpen && v.members.length > 0 ? moreButton('more-members', l.moreMembers, { moreMembers: !l.moreMembers }) : null)}
        {v.error && v.members.length > 0 ? <Text color="error">{`${v.error} -- last known below`}</Text> : null}
        {l.membersOpen ? memberBody : null}
      </Box>
    )

    // --- Secrets ---
    const openForm = (row?: SecretRow) => {
      // The form is wider than the list: re-ask the pane's size once it is drawn.
      void update($, secretForm, (): SecretForm => ({
        ...CLOSED_FORM,
        mode: 'form',
        name: row?.name ?? '',
        members: row && row.members !== '*' ? row.members : '',
        keep: row && row.scope !== 'persistent' ? 'session' : 'persistent',
        replacing: row ? true : undefined,
      })).then(() => (l.secretsOpen ? openPane($) : setLayout($, { secretsOpen: true }))).catch(() => undefined)
    }
    const closeForm = () => {
      setForm(cur => ({ ...CLOSED_FORM, note: cur.note }))
      void refreshSecrets($)
    }
    // Pressing a secret's name puts its token (never its value) at the prompt's cursor.
    const insertToken = async (name: string) => {
      const got = await $.prompt.fill({ text: secretToken(name), mode: 'insert' })
      await setNote($, got.isFilled ? `Inserted ${secretToken(name)} at the cursor.` : `Could not insert: the prompt box is not taking text right now.`)
    }
    const formBlock = f.mode === 'form' ? (
      <Box flexDirection="column" paddingLeft={1}>
        {f.replacing || !Input
          ? <Text>{`Name: ${f.name || '(type a name)'}`}{f.replacing ? <Text dimColor>  (replacing its value)</Text> : null}</Text>
          : <Input key="secret-name" label="Name" autoFocus placeholder="GITHUB_TOKEN" value={f.name} submitLabel="ok"
              onInput={(t: string) => setForm(cur => ({ ...cur, name: t.trim() }))}
              onSubmit={(t: string) => setForm(cur => ({ ...cur, name: t.trim() }))} />}
        {l.moreOptions ? (
          <Box flexDirection="column">
            {Input
              ? <Input key="secret-members" label="Members" placeholder="* (all)" value={f.members} submitLabel="ok"
                  onInput={(t: string) => setForm(cur => ({ ...cur, members: t }))}
                  onSubmit={(t: string) => setForm(cur => ({ ...cur, members: t }))} />
              : <Text>{`Members: ${f.members.trim() || '* (all)'}`}</Text>}
            {Select
              ? <Select key="secret-keep" label="Keep" value={f.keep}
                  options={[{ value: 'persistent', label: 'persistent (survives restart)' }, { value: 'session', label: 'this server session only' }]}
                  onSelect={(k: string) => setForm(cur => ({ ...cur, keep: k as SecretForm['keep'] }))} />
              : <Text>{`Keep: ${f.keep}`}</Text>}
            {Select
              ? <Select key="secret-ttl" label="Expires" value={f.ttl}
                  options={[{ value: 'none', label: 'never' }, { value: '1h', label: 'in 1 hour' }, { value: '1d', label: 'in 1 day' }, { value: '7d', label: 'in 7 days' }]}
                  onSelect={(t: string) => setForm(cur => ({ ...cur, ttl: t as SecretForm['ttl'] }))} />
              : <Text>{`Expires: ${f.ttl}`}</Text>}
          </Box>
        ) : null}
        <Text dimColor>
          {f.keep === 'session'
            ? 'Session-only: use the browser link (the command always persists).'
            : l.moreOptions
              ? 'Run in ANOTHER terminal (the value is typed hidden), then Apply:'
              : 'Run in ANOTHER terminal (the value is typed hidden):'}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text color="claude">{cliCommand(f.name || '<NAME>')}</Text>
          <Button key="secret-copy-cmd" label="Copy" onPress={copy(cliCommand(f.name || '<NAME>'))} />
        </Box>
        <Box flexDirection="row" gap={1}>
          {l.moreOptions ? <Button key="secret-apply" label="Apply members and expiry" variant="primary" onPress={() => void applySettings($)} /> : null}
          <Button key="secret-link" label="Get browser link" onPress={() => void requestEntryLink($)} />
          <Button key="secret-options" label={l.moreOptions ? 'fewer options' : `more options${MORE}`} plain dimColor onPress={toggle({ moreOptions: !l.moreOptions })} />
          <Button key="secret-cancel" label="Close" onPress={closeForm} />
        </Box>
      </Box>
    ) : f.mode === 'link' && f.link ? (
      <Box flexDirection="column" paddingLeft={1}>
        <Text dimColor>{`Open once and type the value for ${f.name} there${f.linkExpires ? ` (expires ${f.linkExpires})` : ''}:`}</Text>
        <Box flexDirection="row" gap={1}>
          <Link href={f.link} />
          <Button key="secret-copy-link" label="Copy" onPress={copy(f.link)} />
        </Box>
        {f.warning ? <Text color="error">{`Careful: ${f.warning}`}</Text> : null}
        <Box flexDirection="row" gap={1}>
          <Button key="secret-done" label="Done" variant="primary" onPress={closeForm} />
        </Box>
      </Box>
    ) : null

    const expiring = s.items.filter(expiresSoon).length
    const nameWidth = Math.min(28, Math.max(0, ...s.items.map(r => r.name.length)) + 2)
    const secretsBlock = (
      <Box flexDirection="column">
        {rule}
        {sectionHeader('fold-secrets', l.secretsOpen, `${KEY} Secrets ${s.items.length}`,
          expiring > 0 ? <Text color="warning">{`${expiring} expiring`}</Text> : null,
          <Box flexDirection="row" gap={2}>
            {l.secretsOpen && s.items.length > 0 ? moreButton('more-secrets', l.moreSecrets, { moreSecrets: !l.moreSecrets }) : null}
            {/* Always drawn: a pressed control that vanished would drop the pane's focus back to the prompt. */}
            <Button key="secret-add" label="add" plain onPress={() => openForm()} />
          </Box>)}
        {l.secretsOpen ? (
          <Box flexDirection="column">
            {s.error ? <Text color="error">{`secrets: ${s.error}`}</Text> : null}
            {s.items.length === 0
              ? (s.error ? null : <Text dimColor>No secrets stored.</Text>)
              : s.items.map(row => (
                <Box flexDirection="row">
                  <Box width={nameWidth}>
                    <Button key={`secret-insert:${row.name}`} label={row.name} plain onPress={() => void insertToken(row.name)} />
                  </Box>
                  {l.moreSecrets ? <Box width={12}><Text dimColor>{row.scope}</Text></Box> : null}
                  {l.moreSecrets ? <Box width={16}><Text dimColor wrap="truncate-end">{row.members === '*' ? 'all members' : row.members}</Text></Box> : null}
                  <Box flexGrow={1} marginRight={1}>
                    {l.moreSecrets || expiresSoon(row)
                      ? <Text color={expiresSoon(row) ? 'warning' : undefined} dimColor={!expiresSoon(row)} wrap="truncate-end">{expiryLabel(row.expiry)}</Text>
                      : null}
                  </Box>
                  <Box flexDirection="row" gap={1}>
                    <Button key={`secret-replace:${row.name}`} label="replace" plain dimColor onPress={() => openForm(row)} />
                    <Button key={`secret-delete:${row.name}`} label={CROSS} plain dimColor
                      onPress={() => setForm(cur => ({ ...cur, confirmDelete: row.name, note: undefined }))} />
                  </Box>
                </Box>
              ))}
            {f.confirmDelete ? (
              <Box flexDirection="row" gap={1}>
                <Text color="warning">{`Delete secret ${f.confirmDelete}?`}</Text>
                <Button key="secret-delete-confirm" label="Delete" variant="primary" onPress={() => void deleteSecret($, f.confirmDelete!)} />
                <Button key="secret-delete-cancel" label="Cancel" onPress={() => setForm(cur => ({ ...cur, confirmDelete: undefined }))} />
              </Box>
            ) : null}
            {formBlock}
            {f.note ? <Text color={/^(No link|Not applied|Could not)/.test(f.note) ? 'error' : 'success'}>{f.note}</Text> : null}
          </Box>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column" width={width}>
        {header}
        {membersBlock}
        {secretsBlock}
        <Text dimColor>{FOOTER}</Text>
      </Box>
    )
  })
}
