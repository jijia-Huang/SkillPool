import { expect, mock, test } from 'claude-code/testing'

import { isSkillAllowed, isToolAllowed, makePolicy, mcpPrefix, sectionText } from './policy'

const HOME = 'C:/home'
const DIR = `${HOME}/.claude/skillpool/profiles`
const DOCS = {
  description: 'Docs only',
  skills: { only: ['wiki-archive'] },
  plugins: { off: ['herdr-commander@herdr-commander'] },
  mcp: { only: [] },
  instructions: { append: ['rules.md'] },
}

const norm = (path: string) => path.split('\\').join('/')

// A machine with one user profile, `docs`, and one user skill besides it.
function world(on: any, env: Record<string, string> = {}) {
  mock.env(on, { USERPROFILE: HOME, ...env })
  on('session.root', () => ({ value: 'D:/proj' }))
  on('session.cwd', () => ({ value: 'D:/proj' }))
  on('fs.exists', ($: any, e: any) => ({ value: norm(e.path) === DIR }))
  on('fs.list', () => ({ value: [{ name: 'docs.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.read', ($: any, e: any) => {
    if (norm(e.path) === `${DIR}/docs.json`) return { value: JSON.stringify(DOCS) }
    if (norm(e.path) === `${DIR}/rules.md`) return { value: '# Rules\nShort sentences.' }
    return { deny: 'ENOENT' }
  })
  on('command.list', () => ({
    value: [
      { name: 'spine-cli', description: '', source: 'user' },
      { name: 'wiki-archive', description: '', source: 'user' },
      { name: 'clear', description: '', source: 'builtin' },
    ],
  }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.run', () => ({ text: 'ran' }))
  on('tool.call', () => ({ result: 'ok' }))
}

const run = ($: any, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

test('policy: only-list, plugins off and MCP prefixes', () => {
  const p = makePolicy(DOCS)
  expect(isSkillAllowed(p, 'wiki-archive', 'model')).toBe(true)
  expect(isSkillAllowed(p, 'spine-cli', 'model')).toBe(false)
  expect(isSkillAllowed(p, 'spine-cli', 'person')).toBe(false)
  expect(isSkillAllowed(p, 'skillpool:profile', 'model')).toBe(true)
  expect(isToolAllowed(p, 'mcp__herdr-commander__herdr_worker_spawn')).toBe(false)
  expect(isToolAllowed(p, 'mcp__devbridge__eval')).toBe(false)
  expect(isToolAllowed(p, 'Read')).toBe(true)
  const slashOnly = makePolicy({ skills: { only: ['a'], others: 'user-invocable-only' } })
  expect(isSkillAllowed(slashOnly, 'b', 'model')).toBe(false)
  expect(isSkillAllowed(slashOnly, 'b', 'person')).toBe(true)
  expect(mcpPrefix('claude.ai magnificAI\u5f71\u50cf')).toBe('mcp__claude_ai_magnificAI')
  expect(sectionText('# A\nx\n## B\ny\n# C\nz', 'B')).toBe('## B\ny')
})

test('/skillpool docs switches, tells the model, and refuses what the profile leaves out', async ($: any, on: any) => {
  world(on)
  const switched = await run($, 'skillpool', 'docs')
  expect(switched.text).toContain('switched to profile "docs"')
  expect(switched.context?.[0]).toContain('Skills you may use: wiki-archive')
  expect(switched.context?.[0]).toContain('Short sentences.')

  const hidden = await $.tool.call({ tool: 'Skill', tool_use_id: 't1', skill: 'spine-cli' })
  expect(hidden.deny).toContain('off in the profile "docs"')
  const kept = await $.tool.call({ tool: 'Skill', tool_use_id: 't2', skill: 'wiki-archive' })
  expect(kept.deny).toBeUndefined()
  const mcp = await $.tool.call({ tool: 'mcp__herdr-commander__herdr_worker_spawn', tool_use_id: 't3' })
  expect(mcp.deny).toBeDefined()

  expect((await run($, 'spine-cli')).text).toContain('/spine-cli is off')
  expect((await run($, 'wiki-archive')).text).toBe('ran')
  expect((await run($, 'clear')).text).toBe('ran')

  await run($, 'skillpool', 'off')
  const again = await $.tool.call({ tool: 'Skill', tool_use_id: 't4', skill: 'spine-cli' })
  expect(again.deny).toBeUndefined()
})

test('/skillpool with an unknown name changes nothing', async ($: any, on: any) => {
  world(on)
  const r = await run($, 'skillpool', 'nope')
  expect(r.text).toContain('no profile "nope"')
  const call = await $.tool.call({ tool: 'Skill', tool_use_id: 't1', skill: 'spine-cli' })
  expect(call.deny).toBeUndefined()
})

test('a session started by `skillpool docs` starts with docs on', async ($: any, on: any) => {
  world(on, { AGENT_PROFILE: 'docs' })
  on('command.register', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'D:/proj', surface: null, isInteractive: false })
  const call = await $.tool.call({ tool: 'Skill', tool_use_id: 't1', skill: 'spine-cli' })
  expect(call.deny).toContain('off in the profile "docs"')
  const off = await run($, 'skillpool', 'off')
  expect(off.text).toContain('claude -r sid-1')
})
