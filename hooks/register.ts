// SkillPool mod: `/skillpool <profile>` switches the profile mid-session.
//
// What it can do in every session: refuse calls outside the profile (the Skill
// tool, `/skill` commands, MCP tools, subagent types), hide a plugin's agent
// types, shrink hidden MCP tools' descriptions, and tell the model the new
// rules and the profile's instructions. Rewriting the skill listing, CLAUDE.md
// or the system prompt is not done here: where an organization manages Claude
// Code those events pass over the plugins a person installs.

import type { EngineInterface, Register } from 'claude-code'

import type { SkillpoolActive } from '../types'
import {
  isAgentAllowed,
  isSkillAllowed,
  isToolAllowed,
  makePolicy,
  profileNote,
  sectionText,
  type ProfileData,
} from './policy'

const ACTIVE = { plugin: 'skillpool', key: 'active' } as const
const LAUNCHED = { plugin: 'skillpool', key: 'launched' } as const
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/

type Found = { name: string; scope: string; path: string; root: string | null; data: ProfileData }
type Engine = EngineInterface

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

async function home($: Engine): Promise<string> {
  return slash((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~')
}

/** Profile folders, user first; a project folder found later wins for the same name. */
async function profileDirs($: Engine): Promise<{ scope: string; dir: string; root: string | null }[]> {
  const dirs = [{ scope: 'user', dir: `${await home($)}/.claude/skillpool/profiles`, root: null as string | null }]
  const roots = new Set([slash(await $.session.root()), slash(await $.session.cwd())])
  for (const root of roots) dirs.push({ scope: 'project', dir: `${root}/.claude/skillpool/profiles`, root })
  return dirs
}

async function listProfiles($: Engine): Promise<Map<string, Found>> {
  const found = new Map<string, Found>()
  for (const { scope, dir, root } of await profileDirs($)) {
    if (!(await $.fs.exists(dir))) continue
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const name = entry.name.slice(0, -5)
      try {
        const data = JSON.parse(String(await $.fs.read(`${dir}/${entry.name}`))) as ProfileData
        found.set(name, { name, scope, path: `${dir}/${entry.name}`, root, data })
      } catch {
        // an unreadable profile is skipped; `skillpool list` reports it
      }
    }
  }
  return found
}

/** The profile's `instructions.append`, read and cut to the named sections. */
async function appendedText($: Engine, f: Found): Promise<{ text: string; problems: string[] }> {
  const base = f.root ?? f.path.slice(0, f.path.lastIndexOf('/'))
  const parts: string[] = []
  const problems: string[] = []
  for (const item of f.data.instructions?.append ?? []) {
    const file = typeof item === 'string' ? item : item.file
    const section = typeof item === 'string' ? undefined : item.section
    let path = file.startsWith('~') ? (await home($)) + file.slice(1) : file
    if (!/^([A-Za-z]:)?\//.test(slash(path))) path = `${base}/${path}`
    let text: string
    try {
      text = String(await $.fs.read(path))
    } catch {
      problems.push(`not found: ${path}`)
      continue
    }
    if (section) {
      const cut = sectionText(text, section)
      if (cut === null) {
        problems.push(`no section "${section}" in ${path}`)
        continue
      }
      text = cut
    }
    parts.push(text.trim())
  }
  return { text: parts.join('\n\n'), problems }
}

async function activeOf($: Engine): Promise<SkillpoolActive | null> {
  return (await $.state.get(ACTIVE)).value ?? null
}

async function showStatus($: Engine, active: SkillpoolActive | null) {
  $.ui.status(active ? `profile: ${active.name}` : undefined)
}

/** Skills by name the person can type: user and plugin commands, and bundled skills `skillpool check` saw. */
async function skillNames($: Engine): Promise<Set<string>> {
  const names = new Set<string>()
  try {
    const cache = JSON.parse(String(await $.fs.read(`${await home($)}/.claude/skillpool/cache/listing.json`)))
    for (const n of cache.skills ?? []) names.add(n)
  } catch {
    // no cache yet: user and plugin skills are still known below
  }
  for (const c of await $.command.list()) if (c.source === 'user' || c.source === 'plugin') names.add(c.name)
  return names
}

async function refreshCaches($: Engine) {
  for (const event of ['tool.describe', 'prompt.attachment', 'prompt.context'] as const) {
    $.ui.invalidate(event)
  }
}

async function switchTo($: Engine, name: string) {
  const profiles = await listProfiles($)
  const f = profiles.get(name)
  if (!f) {
    const known = [...profiles.keys()].sort().join(', ') || '(none)'
    return { text: `SkillPool: no profile "${name}". Profiles: ${known}` }
  }
  const before = await activeOf($)
  const policy = makePolicy(f.data)
  const { text: appended, problems } = await appendedText($, f)
  const active: SkillpoolActive = { name, scope: f.scope, policy }
  await $.state.set(ACTIVE, active)
  await showStatus($, active)
  await refreshCaches($)
  const lines = [`SkillPool: switched to profile "${name}" (${f.scope}).`]
  if (policy.skillsOnly) lines.push(`Skills: ${policy.skillsOnly.join(', ') || '(none)'}; others ${policy.others}.`)
  if (policy.pluginsOff.length) lines.push(`Plugins off: ${policy.pluginsOff.join(', ')}.`)
  if (policy.mcpOnly) lines.push(`MCP only: ${policy.mcpOnly.join(', ') || '(none)'}.`)
  if (policy.mcpOff.length) lines.push(`MCP off: ${policy.mcpOff.join(', ')}.`)
  for (const p of problems) lines.push(`warning: instructions.append ${p}`)
  lines.push('Outside calls are refused. The skill list and CLAUDE.md the model already read stay in its context; it has been told to ignore what the profile leaves out.')
  const launched = (await $.state.get(LAUNCHED)).value ?? null
  if (launched && launched !== name) {
    lines.push(`This session was started with "skillpool ${launched}": what that launch switched off stays off. For the full "${name}" profile, restart with: skillpool ${name} -r ${await $.session.id()}`)
  }
  return { text: lines.join('\n'), context: [profileNote(name, f.data, policy, appended)] }
}

async function switchOff($: Engine) {
  const before = await activeOf($)
  if (!before) return { text: 'SkillPool: no profile is on.' }
  await $.state.set(ACTIVE, null)
  await showStatus($, null)
  await refreshCaches($)
  const launched = (await $.state.get(LAUNCHED)).value ?? null
  const text = launched
    ? `SkillPool: profile "${before.name}" switched off here; what "skillpool ${launched}" switched off at launch stays off. Restart without it: claude -r ${await $.session.id()}`
    : `SkillPool: profile "${before.name}" switched off.`
  return { text, context: [`[SkillPool] The profile "${before.name}" is off: every skill and tool is available again.`] }
}

async function listText($: Engine) {
  const profiles = await listProfiles($)
  const active = await activeOf($)
  if (!profiles.size) return 'SkillPool: no profiles yet. Create one with /skillpool:profile.'
  const rows = [...profiles.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => `- ${p.name} (${p.scope})${p.name === active?.name ? ' [on]' : ''}${p.data.description ? ': ' + p.data.description : ''}`)
  return ['SkillPool profiles:', ...rows, '', 'Usage: /skillpool <profile> | /skillpool off'].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'skillpool',
      description: 'Switch the SkillPool profile of this session',
      argumentHint: '[profile | off]',
    })
    // AGENT_PROFILE is read once per session: a reload keeps what /skillpool chose since
    if ((await $.state.get(LAUNCHED)).version === 0) {
      const launched = (await $.env.get('AGENT_PROFILE')) ?? ''
      const f = NAME.test(launched) ? (await listProfiles($)).get(launched) : undefined
      await $.state.set(LAUNCHED, f ? launched : null)
      if (f && !(await activeOf($))) {
        await $.state.set(ACTIVE, { name: launched, scope: f.scope, policy: makePolicy(f.data) })
      }
    }
    await showStatus($, await activeOf($))
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
    if (!isSkillAllowed(active.policy, e.command, 'person') && (await skillNames($)).has(e.command)) {
      return { text: `SkillPool: /${e.command} is off in the profile "${active.name}". /skillpool off switches the profile off.` }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const active = await activeOf($)
    if (!active) return next(e)
    const p = active.policy
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'Skill' && typeof input.skill === 'string' && !isSkillAllowed(p, input.skill, 'model')) {
      return { deny: `SkillPool: the skill "${input.skill}" is off in the profile "${active.name}".` }
    }
    if ((String(e.tool) === 'Agent' || String(e.tool) === 'Task') && typeof input.subagent_type === 'string'
      && !isAgentAllowed(p, input.subagent_type)) {
      return { deny: `SkillPool: the agent type "${input.subagent_type}" is off in the profile "${active.name}".` }
    }
    if (!isToolAllowed(p, e.tool)) {
      return { deny: `SkillPool: ${e.tool} is off in the profile "${active.name}".` }
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
