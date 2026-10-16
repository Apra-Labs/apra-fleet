import { describe, expect, mock, test } from 'claude-code/testing'
import type { McpToolResult, On } from 'claude-code'

import {
  classifyError, clock, entryLinkWarning, expiresSoon, paneRows, parseEntryLink, parseSecrets, parseSnapshot,
  removeNote, secretsStatus, statusLine, summaryText, withSecrets,
} from '../hooks/register'
import type { FleetView } from '../types'

const SNAPSHOT = JSON.stringify({
  version: 'v0.5.0',
  updatedAt: '2026-10-15T00:00:00.000Z',
  members: [
    { id: '1', name: 'alice', icon: 'A', category: 'build', status: 'busy', quietForS: 134, reservedBy: 'sprint-42' },
    { id: '2', name: 'bob', icon: 'B', category: 'build', status: 'idle' },
    { id: '3', name: 'dgx-1', icon: 'G', category: 'gpu', status: 'unknown' },
    { id: '4', name: 'dgx-2', icon: 'H', category: 'gpu', status: 'offline' },
    { id: '5', name: 'scout', icon: 'S', category: null, status: 'idle' },
  ],
})

function viewOf(text: string): FleetView {
  const snap = parseSnapshot([text])
  return { version: snap.version, members: snap.members, fetchedAt: 1 }
}

describe('fleet-status formatting', () => {
  test('clock pads minutes and seconds, adds hours past one', async () => {
    expect(clock(0)).toBe('00:00')
    expect(clock(134)).toBe('02:14')
    expect(clock(3725)).toBe('1:02:05')
  })

  test('parseSnapshot skips non-JSON blocks and normalises members', async () => {
    const snap = parseSnapshot(['onboarding text', SNAPSHOT])
    expect(snap.version).toBe('v0.5.0')
    expect(snap.members.length).toBe(5)
    expect(snap.members[0]).toEqual({ id: '1', name: 'alice', icon: 'A', category: 'build', status: 'busy', quietForS: 134, reservedBy: 'sprint-42' })
    expect(snap.members[4]?.category).toBe(null)
  })

  test('parseSnapshot maps an unrecognised status to unknown', async () => {
    const snap = parseSnapshot([JSON.stringify({ members: [{ id: 'x', name: 'x', status: 'weird' }] })])
    expect(snap.members[0]?.status).toBe('unknown')
  })

  test('parseSnapshot throws on a reply with no members list', async () => {
    expect(() => parseSnapshot(['{"ok":true}'])).toThrow()
  })

  test('status line names the members needing attention and counts the rest', async () => {
    const line = statusLine(viewOf(SNAPSHOT)) ?? ''
    expect(line.includes('alice 02:14')).toBe(true)
    expect(line.includes('dgx-1')).toBe(true)
    expect(line.includes('bob')).toBe(false)
    // unknown (stalled) sorts ahead of busy
    expect(line.indexOf('dgx-1') < line.indexOf('alice')).toBe(true)
    expect(line.endsWith('\u274C 1')).toBe(true)
  })

  test('status line caps the named members', async () => {
    const members = ['a', 'b', 'c', 'd', 'e'].map(n => ({ id: n, name: n, status: 'busy' }))
    const line = statusLine(viewOf(JSON.stringify({ members }))) ?? ''
    expect(line.includes('+2')).toBe(true)
    expect(line.includes(' d')).toBe(false)
  })

  test('status line before the first read, on error and with no members', async () => {
    expect(statusLine({ members: [], fetchedAt: 0 })).toBe(undefined)
    expect(statusLine({ members: [], fetchedAt: 1, error: 'server down' })).toBe('server down')
    expect(statusLine({ members: [], fetchedAt: 1 })).toBe('no members')
  })

  test('pane rows fit the content: members, a label and a gap per category, header and footer', async () => {
    expect(paneRows(viewOf(SNAPSHOT))).toBe(4 + 5 + 3 * 2)
    expect(paneRows(viewOf(JSON.stringify({ members: [{ id: 'a', name: 'a', status: 'idle' }] })))).toBe(5)
    expect(paneRows({ members: [], fetchedAt: 1, error: 'server down' })).toBe(4)
  })

  test('summary text counts by state', async () => {
    expect(summaryText(viewOf(SNAPSHOT))).toBe('5 members: 1 busy, 1 unknown, 2 idle, 1 offline')
  })
})

// The test's mcp.call hook beneath the plugin answers its $.mcp.call as the
// apra-fleet server would: fleet_snapshot with `reply`, credential_store_list
// with no secrets, and any other tool from `tools` (every call is recorded).
// ui.open and ui.status stand in for the surface: the pane is placed and the
// status line text is kept for the test to read.
type Seen = { status: (string | undefined)[]; reads: number; calls: { tool: string; args: Record<string, unknown> }[] }
type Reply = McpToolResult | { deny: string }
function serveSnapshot(on: On, reply: Reply, tools: Record<string, Reply> = {}): Seen {
  const seen: Seen = { status: [], reads: 0, calls: [] }
  const all: Record<string, Reply> = { credential_store_list: text('[]'), ...tools, fleet_snapshot: reply }
  on('mcp.call', ($, e) => {
    expect(e.server).toBe('apra-fleet')
    seen.calls.push({ tool: e.tool, args: (e.args ?? {}) as Record<string, unknown> })
    if (e.tool === 'fleet_snapshot') seen.reads += 1
    const r = all[e.tool]
    if (!r) return { deny: `no tool "${e.tool}" in this test` }
    return 'deny' in r ? r : { value: r }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  return seen
}

function text(t: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: t }], isError }
}

const RUN = {
  command: 'fleet-status',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const PANE_PROPS = { title: 'Fleet', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

describe('fleet-status pane', () => {
  test('/fleet-status reads the snapshot and draws every member on terminal and desktop', async ($, on) => {
    const seen = serveSnapshot(on, { content: [{ type: 'text', text: SNAPSHOT }], isError: false })
    const ran = await $.command.run(RUN)
    expect(ran.text).toBe('5 members: 1 busy, 1 unknown, 2 idle, 1 offline')
    expect(seen.status.at(-1)?.includes('alice 02:14')).toBe(true)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'fleet-status', surface, component: 'Pane', requestId: 'fleet-status', props: PANE_PROPS })
      for (const text of ['apra-fleet', 'v0.5.0', 'alice', 'quiet 02:14', 'held by sprint-42', 'dgx-2', 'build', 'gpu', 'uncategorized', 'may be stalled']) {
        expect(await ui.find({ type: 'Text', text })).toBeDefined()
      }
      await ui.unmount()
    }
  })

  test('a server not answering right after start reads as connecting', async ($, on) => {
    serveSnapshot(on, { deny: 'no tool "fleet_snapshot" on a server named "apra-fleet"; servers with tools: none' })
    const ran = await $.command.run(RUN)
    expect(ran.text).toBe('connecting...')
    const ui = await $.ui.mount({ plugin: 'fleet-status', surface: 'terminal', component: 'Pane', requestId: 'fleet-status', props: { ...PANE_PROPS, placement: 'inline' } })
    expect(await ui.find({ type: 'Text', text: /connecting/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('fleet-status errors', () => {
  // The text Claude Code 2.1.300 gives $.mcp.call for a server that is still
  // starting or is down (captured from a live session).
  const NONE = 'no tool "fleet_snapshot" on a server named "apra-fleet"; servers with tools: none'
  const OLD = 'no tool "fleet_snapshot" on a server named "apra-fleet"; servers with tools: apra-fleet'

  test('starting vs down is decided by time since session start', async () => {
    expect(classifyError(NONE, 5_000)).toBe('connecting...')
    expect(classifyError(NONE, 61_000)).toBe('server not reachable')
  })

  test('a connected server without the tool is an older apra-fleet', async () => {
    expect(classifyError(OLD, 5_000)).toBe('server too old: update apra-fleet')
    expect(classifyError(OLD, 120_000)).toBe('server too old: update apra-fleet')
  })

  test('a stale list stays visible under the error', async ($, on) => {
    serveSnapshot(on, { content: [{ type: 'text', text: SNAPSHOT }], isError: false })
    await $.command.run(RUN)
    const v = viewOf(SNAPSHOT)
    expect(paneRows({ ...v, error: 'server not reachable' })).toBe(paneRows(v) + 1)
  })
})

describe('fleet-status tool.call wrapper', () => {
  test('passes apra-fleet calls through untouched and re-reads after them; ignores other tools', async ($, on) => {
    mock.clock(on)
    const seen = serveSnapshot(on, { content: [{ type: 'text', text: SNAPSHOT }], isError: false })
    let ran = 0
    on('tool.call', { tool: 'mcp__apra-fleet__version' }, () => {
      ran += 1
      return { result: { content: [{ type: 'text', text: 'apra-fleet v0.5.0' }] } }
    })
    on('tool.call', { tool: 'Read' }, () => ({ result: 'file text' }))

    const before = seen.reads
    const out = await $.tool.call({ tool: 'mcp__apra-fleet__version', input: {} } as never)
    expect(ran).toBe(1)
    expect(JSON.stringify(out.result)).toBe(JSON.stringify({ content: [{ type: 'text', text: 'apra-fleet v0.5.0' }] }))
    expect(seen.reads).toBe(before + 1)

    const afterFleet = seen.reads
    await $.tool.call({ tool: 'Read', input: { file_path: '/x' } } as never)
    expect(seen.reads).toBe(afterFleet)
    // Let the re-read the apra-fleet call started (snapshot, then secrets)
    // settle before the test ends: /fleet-status joins the one in flight.
    await $.command.run(RUN)
  })
})


const SECRETS = JSON.stringify([
  { name: 'GITHUB_TOKEN', scope: 'persistent', network_policy: 'allow', created_at: '2026-10-16', members: '*', expiry: 'none' },
  { name: 'aws_key', scope: 'session', network_policy: 'allow', created_at: '2026-10-16', members: 'alice,bob', expiry: '12m 3s remaining' },
])

describe('fleet-status secrets formatting', () => {
  test('parseSecrets keeps names and settings, sorted', async () => {
    const rows = parseSecrets(['note', SECRETS])
    expect(rows.map(r => r.name)).toEqual(['aws_key', 'GITHUB_TOKEN'])
    expect(rows[0]).toEqual({ name: 'aws_key', scope: 'session', members: 'alice,bob', expiry: '12m 3s remaining' })
    expect(() => parseSecrets(['{"x":1}'])).toThrow()
  })

  test('expiring means expired or under an hour left; the status line counts them', async () => {
    const rows = parseSecrets([SECRETS])
    expect(rows.map(expiresSoon)).toEqual([true, false])
    expect(expiresSoon({ name: 'x', scope: '', members: '*', expiry: '3h 2m remaining' })).toBe(false)
    expect(expiresSoon({ name: 'x', scope: '', members: '*', expiry: 'expired' })).toBe(true)
    const s = { items: rows, fetchedAt: 1 }
    expect(secretsStatus(s)).toBe('\uD83D\uDD11 1 expiring')
    expect(withSecrets('\u26A1 alice', s)).toBe('\u26A1 alice  \uD83D\uDD11 1 expiring')
    expect(withSecrets('x', { items: [], fetchedAt: 1 })).toBe('x')
  })

  test('the entry link is fine over https or loopback, flagged over plain http elsewhere', async () => {
    expect(entryLinkWarning('https://fleet.example.com/ui/#/secret-entry/abc')).toBe(undefined)
    expect(entryLinkWarning('http://127.0.0.1:7601/ui/#/secret-entry/abc')).toBe(undefined)
    expect(entryLinkWarning('http://localhost:7601/x')).toBe(undefined)
    expect(entryLinkWarning('http://[::1]:7601/x')).toBe(undefined)
    expect(entryLinkWarning('http://10.0.0.5:7601/x')?.startsWith('plain http to 10.0.0.5:7601')).toBe(true)
  })

  test('parseEntryLink reads the link and expiry, or the failure', async () => {
    const ok = parseEntryLink(['Open this URL to provide the secret for "K" (expires 18:40:00):\nhttp://127.0.0.1:7601/ui/#/secret-entry/t0k'])
    expect(ok).toEqual({ link: 'http://127.0.0.1:7601/ui/#/secret-entry/t0k', expires: '18:40:00' })
    expect(parseEntryLink(['[FAIL] name taken'])).toEqual({ error: 'name taken' })
    // Claude Code hands a plugin the structured reply as JSON text.
    const LINK = 'http://127.0.0.1:7523/ui/#/secret-entry/abc'
    expect(parseEntryLink([JSON.stringify({ url: '/ui/#/secret-entry/abc', expiresAt: 'T1', absoluteUrl: LINK })])).toEqual({ link: LINK, expires: 'T1' })
    expect(parseEntryLink([], { absoluteUrl: LINK, expiresAt: 'T2' })).toEqual({ link: LINK, expires: 'T2' })
    expect('error' in parseEntryLink(['nothing here'])).toBe(true)
  })

  test('removeNote reports removal, or the server refusal without the force hint', async () => {
    expect(removeNote('bob', ['\u2705 Member "bob" (2) has been removed.\n\nTo refresh...'])).toBe('Removed bob.')
    expect(removeNote('bob', ['\u26D4 Member "bob" is currently busy. Wait for the task to complete or set force=true to remove anyway.']))
      .toBe('Not removed: Member "bob" is currently busy. Wait for the task to complete')
    expect(removeNote('bob', ['\u26D4 Cannot remove member "bob": held by sprint-42. Error code: member-held. Set force=true to remove anyway.']))
      .toBe('Not removed: Cannot remove member "bob": held by sprint-42.')
  })
})

const MOUNT = { plugin: 'fleet-status', surface: 'terminal', component: 'Pane', requestId: 'fleet-status', props: PANE_PROPS } as const
const OK = text(SNAPSHOT)

describe('fleet-status secrets pane', () => {
  test('lists secrets by name and settings, never asking for a value', async ($, on) => {
    const seen = serveSnapshot(on, OK, { credential_store_list: text(SECRETS) })
    await $.command.run(RUN)
    expect(seen.status.at(-1)?.endsWith('\uD83D\uDD11 1 expiring')).toBe(true)
    const ui = await $.ui.mount(MOUNT)
    for (const t of ['GITHUB_TOKEN', 'aws_key', 'all members', 'alice,bob', '12m 3s remaining', 'no expiry']) {
      expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
    }
    await ui.unmount()
  })

  test('add: the terminal command comes first; the browser link sends only name and settings', async ($, on) => {
    const LINK = 'http://10.0.0.5:7601/ui/#/secret-entry/t0k'
    const seen = serveSnapshot(on, OK, {
      credential_store_set: text(`Open this URL to provide the secret for "NEW_KEY" (expires 18:40:00):\n${LINK}`),
    })
    await $.command.run(RUN)
    const ui = await $.ui.mount(MOUNT)
    await ui.press({ key: 'secret-add' })
    await ui.input({ key: 'secret-name', text: 'NEW_KEY', kind: 'submit' })
    await ui.select({ key: 'secret-ttl', value: '1d' })
    expect(await ui.find({ type: 'Text', text: 'apra-fleet secret --set NEW_KEY --persist' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ANOTHER terminal/ })).toBeDefined()

    await ui.press({ key: 'secret-link' })
    const set = seen.calls.find(c => c.tool === 'credential_store_set')
    expect(set?.args).toEqual({ name: 'NEW_KEY', prompt: 'Value for NEW_KEY', persist: true, members: '*', return_url: true, ttl_seconds: 86400 })
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Careful: plain http to 10\.0\.0\.5/ })).toBeDefined()
    await ui.unmount()
  })

  test('add rejects a bad name before calling the server', async ($, on) => {
    const seen = serveSnapshot(on, OK)
    await $.command.run(RUN)
    const ui = await $.ui.mount(MOUNT)
    await ui.press({ key: 'secret-add' })
    await ui.input({ key: 'secret-name', text: 'bad name!', kind: 'submit' })
    await ui.press({ key: 'secret-link' })
    expect(seen.calls.some(c => c.tool === 'credential_store_set')).toBe(false)
    expect(await ui.find({ type: 'Text', text: /^Name: letters/ })).toBeDefined()
    await ui.unmount()
  })

  test('apply after the terminal command updates members and expiry only', async ($, on) => {
    const seen = serveSnapshot(on, OK, { credential_store_list: text(SECRETS), credential_store_update: text('updated') })
    await $.command.run(RUN)
    const ui = await $.ui.mount(MOUNT)
    await ui.press({ key: 'secret-replace:aws_key' })
    await ui.input({ key: 'secret-members', text: 'alice', kind: 'submit' })
    await ui.press({ key: 'secret-apply' })
    expect(seen.calls.find(c => c.tool === 'credential_store_update')?.args).toEqual({ name: 'aws_key', members: 'alice' })
    expect(await ui.find({ type: 'Text', text: 'Settings applied to aws_key.' })).toBeDefined()
    await ui.unmount()
  })

  test('delete asks to confirm, then deletes by name', async ($, on) => {
    const seen = serveSnapshot(on, OK, { credential_store_list: text(SECRETS), credential_store_delete: text('deleted') })
    await $.command.run(RUN)
    const ui = await $.ui.mount(MOUNT)
    await ui.press({ key: 'secret-delete:GITHUB_TOKEN' })
    expect(seen.calls.some(c => c.tool === 'credential_store_delete')).toBe(false)
    expect(await ui.find({ type: 'Text', text: 'Delete secret GITHUB_TOKEN?' })).toBeDefined()
    await ui.press({ key: 'secret-delete-confirm' })
    expect(seen.calls.find(c => c.tool === 'credential_store_delete')?.args).toEqual({ name: 'GITHUB_TOKEN' })
    expect(await ui.find({ type: 'Text', text: 'Deleted GITHUB_TOKEN.' })).toBeDefined()
    await ui.unmount()
  })
})

describe('fleet-status remove member', () => {
  test('remove asks to confirm, never forces, and shows a refusal', async ($, on) => {
    const seen = serveSnapshot(on, OK, {
      remove_member: text('\u26D4 Member "alice" is currently busy. Wait for the task to complete or set force=true to remove anyway.'),
    })
    await $.command.run(RUN)
    const ui = await $.ui.mount(MOUNT)
    await ui.press({ key: 'remove:alice' })
    expect(seen.calls.some(c => c.tool === 'remove_member')).toBe(false)
    expect(await ui.find({ type: 'Text', text: 'Remove alice from the fleet?' })).toBeDefined()
    await ui.press({ key: 'remove-confirm' })
    expect(seen.calls.find(c => c.tool === 'remove_member')?.args).toEqual({ member_name: 'alice' })
    expect(await ui.find({ type: 'Text', text: /^Not removed: Member "alice" is currently busy/ })).toBeDefined()
    await ui.unmount()
  })

  test('cancel clears the confirm without a call', async ($, on) => {
    const seen = serveSnapshot(on, OK)
    await $.command.run(RUN)
    const ui = await $.ui.mount(MOUNT)
    await ui.press({ key: 'remove:bob' })
    await ui.press({ key: 'remove-cancel' })
    expect(await ui.find({ type: 'Text', text: 'Remove bob from the fleet?' })).toBe(undefined)
    expect(seen.calls.some(c => c.tool === 'remove_member')).toBe(false)
    await ui.unmount()
  })
})
