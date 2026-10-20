import { expect, mock, test } from 'claude-code/testing'

import {
  INDEX_END,
  INDEX_START,
  MEMORY_HEADING,
  isSkillAllowed,
  isToolAllowed,
  makePolicy,
  mcpPrefix,
  profileRelative,
  writeRefusal,
  type ProfileData,
} from './policy'

const HOME = 'C:/home'
const SP = `${HOME}/.claude/skillpool`
const PROFILES: Record<string, ProfileData> = {
  docs: {
    description: 'Docs only',
    skills: { use: ['wiki-archive'], off: ['spine-cli'] },
    plugins: { off: ['herdr-commander@herdr-commander'] },
    mcp: { only: [] },
  },
  spine: { description: 'Spine work', skills: { use: ['spine-cli'] } },
}
const CLAUDE_MD = `# docs profile\nShort sentences.\n\n${MEMORY_HEADING}\n- a fact\n\n${INDEX_START}\nindex\n${INDEX_END}\n`

const norm = (path: string) => path.split('\\').join('/')

// A machine with two profiles and the launcher's config; records what the mod asks of the host.
function world(on: any, env: Record<string, string> = {}) {
  const calls = { cli: [] as string[], commands: [] as string[], compacts: 0, env: [] as string[] }
  mock.env(on, { USERPROFILE: HOME, ...env })
  on('env.set', ($: any, e: any) => {
    calls.env.push(`${e.name}=${e.value ?? ''}`)
    return { value: undefined }
  })
  on('session.root', () => ({ value: 'D:/proj' }))
  on('session.cwd', () => ({ value: 'D:/proj' }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('fs.exists', ($: any, e: any) => ({ value: norm(e.path) === `${SP}/profiles` }))
  on('fs.list', () => ({
    value: Object.keys(PROFILES).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', ($: any, e: any) => {
    const p = norm(e.path)
    for (const [name, data] of Object.entries(PROFILES)) {
      if (p === `${SP}/profiles/${name}/profile.json`) return { value: JSON.stringify(data) }
    }
    if (p === `${SP}/config.json`) return { value: JSON.stringify({ python: 'py', script: 'skillpool.py' }) }
    if (p.endsWith('/CLAUDE.md')) return { value: CLAUDE_MD }
    return { deny: 'ENOENT' }
  })
  on('fs.write', () => ({ value: undefined }))
  on('process.run', ($: any, e: any) => {
    calls.cli.push(JSON.stringify(e))
    const context = JSON.stringify({ context: '# SkillPool profile: x\nShort sentences.' })
    const stdout = `attached: x\nmemory: ${SP}/profiles/x/memory/D--proj\nnote: mcp: the servers stay connected\ncontext-json: ${context}`
    return { value: { exitCode: 0, stdout, stderr: '' } }
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
  on('ui.toast', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.compact', () => {
    calls.compacts++
    return { skip: 'test' }
  })
  on('command.run', ($: any, e: any) => {
    calls.commands.push(`${e.command} ${e.args}`.trim())
    return { text: 'ran' }
  })
  on('tool.call', () => ({ result: 'ok' }))
  return calls
}

const run = ($: any, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

test('policy: switched-off skills, plugins and MCP', () => {
  const p = makePolicy(PROFILES.docs!)
  expect(isSkillAllowed(p, 'wiki-archive')).toBe(true)
  expect(isSkillAllowed(p, 'spine-cli')).toBe(false)
  expect(isSkillAllowed(p, 'herdr-commander:x')).toBe(false)
  expect(isSkillAllowed(p, 'skillpool:profile')).toBe(true)
  expect(isToolAllowed(p, 'mcp__herdr-commander__herdr_worker_spawn')).toBe(false)
  expect(isToolAllowed(p, 'mcp__devbridge__eval')).toBe(false)
  expect(isToolAllowed(p, 'Read')).toBe(true)
  expect(mcpPrefix('claude.ai magnificAI\u5f71\u50cf')).toBe('mcp__claude_ai_magnificAI')
})

test('the model keeps memory but not the rules of a profile', () => {
  expect(profileRelative(`${SP}\\sessions\\m-1\\CLAUDE.md`, SP)).toBe('claude.md')
  expect(profileRelative(`${SP}/profiles/docs/memory/k/MEMORY.md`, SP)).toBe('memory/k/memory.md')
  expect(profileRelative('D:/proj/CLAUDE.md', SP)).toBe(null)
  const edit = (old: string, neu = 'x') => writeRefusal('claude.md', { kind: 'edit', text: CLAUDE_MD, oldStrings: [old], newStrings: [neu] })
  expect(edit('Short sentences.')).toContain('rules')
  expect(edit('- a fact')).toBe(null)
  expect(edit('index')).toContain('memory index')
  expect(edit('- a fact', `${INDEX_START}`)).toContain('markers')
  expect(writeRefusal('claude.md', { kind: 'write' })).toContain('not rewritten whole')
  expect(writeRefusal('memory/k/memory.md', { kind: 'write' })).toBe(null)
  expect(writeRefusal('profile.json', { kind: 'write' })).toContain('skillpool save')
})

test('/skillpool docs in a plain session: link, add the folder once, then switch by compacting', async ($: any, on: any) => {
  const calls = world(on)
  const clock = mock.clock(on)
  const r = await run($, 'skillpool', 'docs')
  expect(r.text).toContain('switching to profile "docs"')
  expect(r.text).toContain('Yes, for this session')
  expect(r.text).not.toContain('context-json')
  expect(r.context?.[0]).toContain('Short sentences.')
  expect(calls.env).toContain('AGENT_PROFILE=docs')
  expect(calls.cli[0]).toContain('m-sid-1')
  expect(calls.cli[0]).toContain('attach')
  await clock.advance(1000)
  expect(calls.commands).toContain(`add-dir ${SP}/sessions/m-sid-1`)
  expect(calls.compacts).toBe(0)

  expect((await $.tool.call({ tool: 'Skill', tool_use_id: 't1', skill: 'spine-cli' })).deny).toContain('off in the profile "docs"')
  expect((await $.tool.call({ tool: 'Skill', tool_use_id: 't2', skill: 'wiki-archive' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'mcp__devbridge__eval', tool_use_id: 't3' })).deny).toBeDefined()
  expect((await run($, 'spine-cli')).text).toContain('/spine-cli is off')

  const again = await run($, 'skillpool', 'spine')
  expect(again.text).toContain('compacted next')
  await clock.advance(1000)
  expect(calls.compacts).toBe(1)
  expect((await $.tool.call({ tool: 'Skill', tool_use_id: 't4', skill: 'spine-cli' })).deny).toBeUndefined()

  const memoryFile = `${HOME}/.claude/projects/D--proj/memory/x.md`
  const native = await $.tool.call({ tool: 'Write', tool_use_id: 'n1', file_path: memoryFile, content: 'x' })
  expect(native.deny).toContain(`${SP}/profiles/x/memory/D--proj`)

  const off = await run($, 'skillpool', 'off')
  expect(calls.cli.at(-1)).toContain('--empty')
  expect(off.context?.[0]).toContain('no longer apply')
  expect(calls.env).toContain('AGENT_PROFILE=')
  expect((await $.tool.call({ tool: 'Write', tool_use_id: 'n2', file_path: memoryFile, content: 'x' })).deny).toBeUndefined()
})

test('writes into a profile go through the guard', async ($: any, on: any) => {
  world(on)
  const md = `${SP}/sessions/m-sid-1/CLAUDE.md`
  const rules = await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: md, old_string: 'Short sentences.', new_string: 'Long.' })
  expect(rules.deny).toContain('rules')
  const memory = await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: md, old_string: '- a fact', new_string: '- two facts' })
  expect(memory.deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', tool_use_id: 'e3', file_path: `${SP}/profiles/docs/profile.json`, content: '{}' })).deny).toBeDefined()
  expect((await $.tool.call({ tool: 'Write', tool_use_id: 'e4', file_path: `${SP}/profiles/docs/memory/k/MEMORY.md`, content: '- x' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', tool_use_id: 'e5', file_path: 'D:/proj/notes.md', content: 'x' })).deny).toBeUndefined()
})

test('/skillpool with an unknown name changes nothing', async ($: any, on: any) => {
  const calls = world(on)
  const r = await run($, 'skillpool', 'nope')
  expect(r.text).toContain('no profile "nope"')
  expect(calls.cli.length).toBe(0)
  expect((await $.tool.call({ tool: 'Skill', tool_use_id: 't1', skill: 'spine-cli' })).deny).toBeUndefined()
})

test('a session started by `skillpool docs` starts with docs on and its link added', async ($: any, on: any) => {
  const calls = world(on, { AGENT_PROFILE: 'docs', SKILLPOOL_SESSION_LINK: `${SP}\\sessions\\l-42` })
  const clock = mock.clock(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'D:/proj', surface: null, isInteractive: false })
  expect((await $.tool.call({ tool: 'Skill', tool_use_id: 't1', skill: 'spine-cli' })).deny).toContain('off in the profile "docs"')
  const r = await run($, 'skillpool', 'spine')
  expect(r.text).toContain('skillpool docs')
  expect(calls.cli[0]).toContain('l-42')
  await clock.advance(1000)
  expect(calls.commands.some(c => c.startsWith('add-dir'))).toBe(false)
  expect(calls.compacts).toBe(1)
  const off = await run($, 'skillpool', 'off')
  expect(off.text).toContain('claude -r sid-1')
})

test('a skillpool-<name> subagent is held to its own profile', async ($: any, on: any) => {
  world(on)
  on('agent.list', () => ({
    value: [
      { id: 'a1', type: 'skillpool-docs', description: 'docs work', status: 'running' },
      { id: 'a2', type: 'general-purpose', description: 'other', status: 'running' },
    ],
  }))
  const call = (agentId: string, skill: string) =>
    $.tool.call({ tool: 'Skill', tool_use_id: `${agentId}-${skill}`, skill, agentId })
  expect((await call('a1', 'spine-cli')).deny).toContain('off in the profile "docs"')
  expect((await call('a1', 'wiki-archive')).deny).toBeUndefined()
  expect((await call('a2', 'spine-cli')).deny).toBeUndefined()
  const mcp = await $.tool.call({ tool: 'mcp__devbridge__eval', tool_use_id: 'a1-mcp', agentId: 'a1' })
  expect(mcp.deny).toBeDefined()
})
