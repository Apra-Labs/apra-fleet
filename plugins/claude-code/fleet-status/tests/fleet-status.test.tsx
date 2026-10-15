import { describe, expect, test } from 'claude-code/testing'
import type { McpToolResult, On } from 'claude-code'

import { clock, paneRows, parseSnapshot, statusLine, summaryText } from '../hooks/register'
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
// apra-fleet server would.
// ui.open and ui.status stand in for the surface: the pane is placed and the
// status line text is kept for the test to read.
function serveSnapshot(on: On, reply: McpToolResult | { deny: string }): { status: (string | undefined)[] } {
  const seen: { status: (string | undefined)[] } = { status: [] }
  on('mcp.call', ($, e) => {
    expect(e.server).toBe('apra-fleet')
    expect(e.tool).toBe('fleet_snapshot')
    return 'deny' in reply ? reply : { value: reply }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  return seen
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

  test('an unreachable server shows the reason and the fix', async ($, on) => {
    serveSnapshot(on, { deny: 'MCP server "apra-fleet" closed' })
    const ran = await $.command.run(RUN)
    expect(ran.text).toBe('server down')
    const ui = await $.ui.mount({ plugin: 'fleet-status', surface: 'terminal', component: 'Pane', requestId: 'fleet-status', props: { ...PANE_PROPS, placement: 'inline' } })
    expect(await ui.find({ type: 'Text', text: /server down/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /apra-fleet start/ })).toBeDefined()
    await ui.unmount()
  })
})
