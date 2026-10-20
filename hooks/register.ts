// SkillPool mod: `/skillpool <profile>` switches the profile mid-session.
//
// A profile is a folder (~/.claude/skillpool/profiles/<name>/). Its skills reach a session through
// one link, sessions/<id>, added to the session as a directory; its CLAUDE.md and memory come from
// the plugin's SessionStart hook (`skillpool hook session-start`, which reads AGENT_PROFILE), at start
// and after every compaction and /clear. Switching points the link at another profile
// (scripts/skillpool.py does all linking), sets AGENT_PROFILE for that hook, hands the model the new
// profile's context and compacts. The mod also refuses what a profile switches off (global skills,
// plugins, MCP tools), keeps the model from rewriting a profile's rules, and keeps memory out of
// Claude Code's own memory folders while a profile is on.

import type { EngineInterface, Register } from 'claude-code'

import type { SkillpoolActive, SkillpoolLink, SkillpoolPolicy } from '../types'
import {
  isAgentAllowed,
  isSkillAllowed,
  isToolAllowed,
  makePolicy,
  profileRelative,
  writeRefusal,
  type ProfileData,
} from './policy'

const ACTIVE = { plugin: 'skillpool', key: 'active' } as const
const LAUNCHED = { plugin: 'skillpool', key: 'launched' } as const
const LINK = { plugin: 'skillpool', key: 'link' } as const
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
const AGENT_PREFIX = 'skillpool-' // the subagents `skillpool agents` generates
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

type Engine = EngineInterface
type Found = { name: string; data: ProfileData }

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const samePath = (a: string, b: string) => slash(a).toLowerCase() === slash(b).toLowerCase()

async function home($: Engine): Promise<string> {
  return slash((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~')
}

async function spHome($: Engine): Promise<string> {
  return `${await home($)}/.claude/skillpool`
}

// This process's own view. A /clear goes on in the same process under a new session id whose
// state starts empty, while the added link and the profile still apply; the next hook copies them over.
const current: { known: boolean; active: SkillpoolActive | null; link: SkillpoolLink | null } = {
  known: false,
  active: null,
  link: null,
}

async function activeOf($: Engine): Promise<SkillpoolActive | null> {
  const s = await $.state.get(ACTIVE)
  if (s.version === 0 && current.known) {
    await $.state.set(ACTIVE, current.active)
    return current.active
  }
  return s.value ?? null
}

async function linkOf($: Engine): Promise<SkillpoolLink | null> {
  const s = await $.state.get(LINK)
  if (s.version === 0 && current.known) {
    await $.state.set(LINK, current.link)
    return current.link
  }
  return s.value ?? null
}

async function remember($: Engine, active: SkillpoolActive | null, link: SkillpoolLink | null) {
  Object.assign(current, { known: true, active, link })
  await $.state.set(ACTIVE, active)
  await $.state.set(LINK, link)
}

async function listProfiles($: Engine): Promise<Map<string, Found>> {
  const found = new Map<string, Found>()
  const dir = `${await spHome($)}/profiles`
  if (!(await $.fs.exists(dir))) return found
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'dir' || entry.isLink || !NAME.test(entry.name)) continue
    try {
      const data = JSON.parse(String(await $.fs.read(`${dir}/${entry.name}/profile.json`))) as ProfileData
      found.set(entry.name, { name: entry.name, data })
    } catch {
      // an unreadable profile is skipped; `skillpool list` reports it
    }
  }
  return found
}

/** Runs scripts/skillpool.py with the Python `skillpool install-shim` recorded. */
async function cli($: Engine, args: string[]): Promise<{ ok: boolean; lines: string[] }> {
  let cfg: { python: string; script: string }
  try {
    cfg = JSON.parse(String(await $.fs.read(`${await spHome($)}/config.json`)))
  } catch {
    return { ok: false, lines: ['SkillPool: run `skillpool install-shim` once; it tells /skillpool where Python is.'] }
  }
  const r = await $.process.run([cfg.python, cfg.script, ...args], { timeoutMs: 120000 })
  const lines = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  return { ok: r.exitCode === 0, lines }
}

// links this process added with /add-dir; the env variable keeps the answer across a reload of the mod
const added = new Set<string>()

/**
 * Removes a mod-made link at exit, where Claude Code allows about a second: too short to start Python.
 * `rmdir` (no /s) removes a junction itself and refuses a real folder with anything in it.
 */
async function dropLink($: Engine, path: string) {
  const win = /^[A-Za-z]:/.test(path)
  const p = win ? path.replace(/\//g, '\\') : path
  await $.process.run(win ? ['cmd', '/c', 'rmdir', p] : ['rm', '-f', p], { timeoutMs: 3000 })
  await $.process.run(win ? ['cmd', '/c', 'del', '/q', `${p}.alive`] : ['rm', '-f', `${p}.alive`], { timeoutMs: 3000 })
}

// A mod-made link carries a heartbeat file; `skillpool` removes links whose heartbeat stopped
// (exit cannot be relied on: Claude Code gives the whole end chain about a second).
let beating = false
function keepAlive($: Engine) {
  if (beating) return
  beating = true
  $.clock.every(10 * 60 * 1000, async () => {
    const link = await linkOf($)
    if (!link?.owned) return
    const active = await activeOf($)
    // swept while the machine slept: point it again (the session still has the path added)
    if (!(await $.fs.exists(link.path)) && active) {
      await cli($, ['session', 'attach', '--link', link.path, '--cwd', slash(await $.session.root()), active.name])
        .catch(() => undefined)
    }
    await $.fs.write(`${link.path}.alive`, new Date().toISOString()).catch(() => undefined)
  })
}

/** Whether this process already has the link as an added directory (launch flag, or our /add-dir). */
async function isAdded($: Engine, link: SkillpoolLink): Promise<boolean> {
  if (added.has(slash(link.path).toLowerCase())) return true
  for (const v of [await $.env.get('SKILLPOOL_SESSION_LINK'), await $.env.get('SKILLPOOL_LINK_ADDED')]) {
    if (v && samePath(v, link.path)) return true
  }
  return false
}

/** The link this session uses: the one it has, the launcher's, or a new one the mod owns. */
async function linkFor($: Engine): Promise<SkillpoolLink> {
  const have = await linkOf($)
  if (have) return have
  const fromLauncher = await $.env.get('SKILLPOOL_SESSION_LINK')
  if (fromLauncher) return { path: slash(fromLauncher), owned: false }
  return { path: `${await spHome($)}/sessions/m-${await $.session.id()}`, owned: true }
}

/**
 * After the command's answer is out (a command cannot run another while its own turn waits):
 * add the link as a directory the first time, else compact so Claude Code re-reads it.
 */
function finishLater($: Engine, link: SkillpoolLink, add: boolean, label: string) {
  $.clock.after(300, async () => {
    try {
      if (add) {
        await $.command.run({ command: 'add-dir', args: link.path })
        added.add(slash(link.path).toLowerCase())
        await $.env.set('SKILLPOOL_LINK_ADDED', link.path)
        const s = (await $.settings.read()) as { permissions?: { additionalDirectories?: string[] } }
        if ((s.permissions?.additionalDirectories ?? []).some(d => samePath(d, link.path))) {
          $.ui.toast(
            'SkillPool: the session folder was saved to settings ("remember"), so every session here loads it. '
              + 'Remove it from permissions.additionalDirectories in .claude/settings.local.json.',
            { timeoutMs: 20000 },
          )
        }
        $.ui.toast(`SkillPool: ${label}`)
        return
      }
      const r = await $.session.compact({
        instructions: `The SkillPool profile changed (${label}). Keep the task's context; drop guidance that came from the previous profile.`,
      })
      $.ui.toast('skip' in r && r.skip ? `SkillPool: ${label} (nothing to compact yet)` : `SkillPool: ${label}`)
    } catch (err) {
      $.ui.toast(`SkillPool: the switch did not finish: ${String(err)}`, { timeoutMs: 15000 })
    }
  })
}

async function showStatus($: Engine, active: SkillpoolActive | null) {
  $.ui.status(active ? `profile: ${active.name}` : undefined)
}

async function refreshCaches($: Engine) {
  $.ui.invalidate('tool.describe')
}

async function switchTo($: Engine, name: string) {
  const f = (await listProfiles($)).get(name)
  if (!f) {
    const known = [...(await listProfiles($)).keys()].sort().join(', ') || '(none)'
    return { text: `SkillPool: no profile "${name}". Profiles: ${known}` }
  }
  const link = await linkFor($)
  const add = !(await isAdded($, link))
  const r = await cli($, ['session', 'attach', '--link', link.path, '--cwd', slash(await $.session.root()), name, '--context'])
  if (!r.ok) return { text: ['SkillPool: the switch failed.', ...r.lines].join('\n') }
  const memory = r.lines.find(l => l.startsWith('memory: '))?.slice('memory: '.length) ?? null
  let context: string | null = null
  try {
    context = JSON.parse(r.lines.find(l => l.startsWith('context-json: '))?.slice('context-json: '.length) ?? 'null')?.context ?? null
  } catch {
    // shown without the context; the hook brings it at the next compaction
  }
  const active: SkillpoolActive = { name, policy: makePolicy(f.data), memory }
  await $.env.set('AGENT_PROFILE', name) // the SessionStart hook reads it after each compaction and /clear
  await remember($, active, link)
  await showStatus($, active)
  await refreshCaches($)
  if (link.owned) keepAlive($)
  finishLater($, link, add, `profile "${name}" is on`)
  const shown = (l: string) => !['attached:', 'memory:', 'context-json:'].some(p => l.startsWith(p))
  const lines = [`SkillPool: switching to profile "${name}".`, ...r.lines.filter(shown)]
  lines.push(add
    ? 'Claude Code will ask to add the profile folder (for its skills): choose "Yes, for this session".'
    : 'The conversation is compacted next, so the previous profile\'s rules and skills drop out.')
  const launched = (await $.state.get(LAUNCHED)).value ?? null
  if (launched && launched !== name) {
    lines.push(
      `This session was started with "skillpool ${launched}": its launch settings (plugins, MCP, model) `
        + `stay until a restart: skillpool ${name} -r ${await $.session.id()}`,
    )
  }
  return context ? { text: lines.join('\n'), context: [context] } : { text: lines.join('\n') }
}

async function switchOff($: Engine) {
  const before = await activeOf($)
  if (!before) return { text: 'SkillPool: no profile is on.' }
  const link = await linkOf($)
  if (link) {
    const r = await cli($, ['session', 'attach', '--link', link.path, '--empty'])
    if (!r.ok) return { text: ['SkillPool: could not switch off.', ...r.lines].join('\n') }
    finishLater($, link, !(await isAdded($, link)), 'no profile')
  }
  await $.env.set('AGENT_PROFILE', undefined)
  await remember($, null, link)
  await showStatus($, null)
  await refreshCaches($)
  const launched = (await $.state.get(LAUNCHED)).value ?? null
  return {
    text: `SkillPool: profile "${before.name}" off; the conversation is compacted next.`
      + (launched ? ` What "skillpool ${launched}" set at launch stays until a restart: claude -r ${await $.session.id()}` : ''),
    context: [`[SkillPool] The profile "${before.name}" is off: its rules and memory no longer apply in this session.`],
  }
}

async function listText($: Engine) {
  const profiles = await listProfiles($)
  const active = await activeOf($)
  if (!profiles.size) return 'SkillPool: no profiles yet. Create one with /skillpool:profile or `skillpool new <name>`.'
  const rows = [...profiles.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => `- ${p.name}${p.name === active?.name ? ' [on]' : ''}${p.data.description ? ': ' + p.data.description : ''}`)
  return ['SkillPool profiles:', ...rows, '', 'Usage: /skillpool <profile> | /skillpool off'].join('\n')
}

/** Skills by name the person can type: user and plugin commands, and bundled skills `skillpool check` saw. */
async function skillNames($: Engine): Promise<Set<string>> {
  const names = new Set<string>()
  try {
    const cache = JSON.parse(String(await $.fs.read(`${await spHome($)}/cache/listing.json`)))
    for (const n of cache.skills ?? []) names.add(n)
  } catch {
    // no cache yet: user and plugin skills are still known below
  }
  for (const c of await $.command.list()) if (c.source === 'user' || c.source === 'plugin') names.add(c.name)
  return names
}

// agent id -> the profile of a skillpool-<name> subagent (null for any other agent); a reload starts it over
const subagentProfiles = new Map<string, { name: string; policy: SkillpoolPolicy } | null>()

/** The profile a `skillpool-<name>` subagent was generated from, by the loop id its calls carry. */
async function subagentProfile($: Engine, agentId: string) {
  if (!subagentProfiles.has(agentId)) {
    const agent = (await $.agent.list()).find(a => a.id === agentId)
    if (!agent) return null // not listed yet: asked again on its next call
    const name = agent.type.startsWith(AGENT_PREFIX) ? agent.type.slice(AGENT_PREFIX.length) : null
    const f = name ? (await listProfiles($)).get(name) : undefined
    subagentProfiles.set(agentId, f ? { name: f.name, policy: makePolicy(f.data) } : null)
  }
  return subagentProfiles.get(agentId) ?? null
}

/** While a profile is on, its memory replaces Claude Code's own (kept per folder in ~/.claude/projects/<x>/memory/). */
async function nativeMemoryRefusal($: Engine, input: Record<string, unknown>): Promise<string | null> {
  const active = await activeOf($)
  const file = typeof input.file_path === 'string' ? slash(input.file_path).toLowerCase() : null
  if (!active || !file) return null
  const projects = `${(await home($)).toLowerCase()}/.claude/projects/`
  if (!file.startsWith(projects) || !file.slice(projects.length).includes('/memory/')) return null
  return `SkillPool: memory in this session belongs to the profile "${active.name}"`
    + (active.memory ? `: write it under ${active.memory}/ (and its MEMORY.md index).` : '.')
}

/** Why a write into a profile folder is refused, or null. */
async function profileWriteRefusal($: Engine, tool: string, input: Record<string, unknown>): Promise<string | null> {
  const file = typeof input.file_path === 'string' ? input.file_path
    : typeof input.notebook_path === 'string' ? input.notebook_path : null
  if (!file) return null
  const rest = profileRelative(file, await spHome($))
  if (rest === null) return null
  if (tool !== 'Edit' && tool !== 'MultiEdit') return writeRefusal(rest, { kind: 'write' })
  const edits = (tool === 'Edit' ? [input] : Array.isArray(input.edits) ? input.edits : []) as Record<string, unknown>[]
  let text: string | null = null
  try {
    text = String(await $.fs.read(file))
  } catch {
    // a file that is not there yet
  }
  return writeRefusal(rest, {
    kind: 'edit',
    text,
    oldStrings: edits.map(x => String(x.old_string ?? '')),
    newStrings: edits.map(x => String(x.new_string ?? '')),
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'skillpool',
      description: 'Switch the SkillPool profile of this session',
      argumentHint: '[profile | off]',
    })
    if ((await $.state.get(LAUNCHED)).version === 0) {
      // first start of this session: what `skillpool <profile>` launched it with
      const launched = (await $.env.get('AGENT_PROFILE')) ?? ''
      const f = NAME.test(launched) ? (await listProfiles($)).get(launched) : undefined
      await $.state.set(LAUNCHED, f ? launched : null)
      const envLink = await $.env.get('SKILLPOOL_SESSION_LINK')
      const memory = (await $.env.get('SKILLPOOL_MEMORY_DIR')) ?? null
      if (f && envLink) await remember($, { name: launched, policy: makePolicy(f.data), memory }, { path: slash(envLink), owned: false })
    } else {
      // a reload, or a resumed session in a new process: a resume loses directories added mid-session
      const active = await activeOf($)
      const link = await linkOf($)
      if (active && link && !(await isAdded($, link))) {
        const fresh: SkillpoolLink = link.owned ? link : { path: `${await spHome($)}/sessions/m-${await $.session.id()}`, owned: true }
        const root = slash(await $.session.root())
        // after start, so Python never holds the session up
        $.clock.after(500, async () => {
          const r = await cli($, ['session', 'attach', '--link', fresh.path, '--cwd', root, active.name]).catch(() => null)
          if (!r?.ok) {
            $.ui.toast(`SkillPool: could not bring back profile "${active.name}"; /skillpool ${active.name} tries again.`)
            return
          }
          await $.env.set('AGENT_PROFILE', active.name)
          await remember($, active, fresh)
          if (fresh.owned) keepAlive($)
          finishLater($, fresh, true, `profile "${active.name}" is back`)
        })
      }
    }
    if ((await linkOf($))?.owned) keepAlive($)
    await showStatus($, await activeOf($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // after /clear or a resume the process goes on with the link still added
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      const link = await linkOf($)
      if (link?.owned) await dropLink($, link.path).catch(() => undefined)
    }
    return next(e)
  })

  // also a heartbeat on each prompt
  on('prompt.submit', async ($, e, next) => {
    try {
      await activeOf($)
      const link = await linkOf($)
      if (link?.owned) await $.fs.write(`${link.path}.alive`, new Date().toISOString())
    } catch {
      // never hold a prompt up for the heartbeat
    }
    return next(e)
  })

  on('command.run', { command: 'skillpool' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '' || arg === 'list') return { text: await listText($) }
    if (arg === 'off' || arg === 'none') return switchOff($)
    if (!NAME.test(arg)) return { text: `SkillPool: "${arg}" is not a profile name.` }
    return switchTo($, arg)
  })

  // `/skill` typed by the person
  on('command.run', async ($, e, next) => {
    const active = await activeOf($)
    if (!active || e.command === 'skillpool') return next(e)
    if (!isSkillAllowed(active.policy, e.command) && (await skillNames($)).has(e.command)) {
      return { text: `SkillPool: /${e.command} is off in the profile "${active.name}". /skillpool off switches the profile off.` }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    if (WRITE_TOOLS.includes(tool)) {
      const refusal = await profileWriteRefusal($, tool, input)
      if (refusal) return { deny: refusal }
      const native = await nativeMemoryRefusal($, input)
      if (native) return { deny: native }
    }
    // the session's profile, and for a skillpool-<name> subagent its own profile too
    const rules: { name: string; policy: SkillpoolPolicy }[] = []
    const active = await activeOf($)
    if (active) rules.push(active)
    if (e.agentId) {
      const own = await subagentProfile($, e.agentId)
      if (own) rules.push(own)
    }
    for (const { name, policy } of rules) {
      if (tool === 'Skill' && typeof input.skill === 'string' && !isSkillAllowed(policy, input.skill)) {
        return { deny: `SkillPool: the skill "${input.skill}" is off in the profile "${name}".` }
      }
      if ((tool === 'Agent' || tool === 'Task') && typeof input.subagent_type === 'string'
        && !isAgentAllowed(policy, input.subagent_type)) {
        return { deny: `SkillPool: the agent type "${input.subagent_type}" is off in the profile "${name}".` }
      }
      if (!isToolAllowed(policy, tool)) {
        return { deny: `SkillPool: ${tool} is off in the profile "${name}".` }
      }
    }
    return next(e)
  })

  on('agent.offer', async ($, e, next) => {
    const active = await activeOf($)
    if (active && !isAgentAllowed(active.policy, e.agent)) return { isOffered: false }
    return next(e)
  })

  on('tool.describe', async ($, e, next) => {
    const active = await activeOf($)
    if (!active || isToolAllowed(active.policy, e.tool)) return next(e)
    return { description: `Off in the SkillPool profile "${active.name}"; calls are refused.`, isDeferred: true }
  })
}
