// Pure profile logic shared by the hooks: no `$`, so the tests call it directly.
// Mirrors scripts/skillpool.py, which applies the same profile files at launch.

import type { SkillpoolPolicy } from '../types'

export type ProfileData = {
  description?: string
  whenToUse?: string
  skills?: {
    only?: string[]
    others?: 'off' | 'user-invocable-only' | 'name-only'
    on?: string[]
    off?: string[]
    nameOnly?: string[]
    userOnly?: string[]
  }
  plugins?: { off?: string[]; on?: string[] }
  mcp?: { only?: string[]; off?: string[] }
  instructions?: { exclude?: string[]; append?: (string | { file: string; section?: string })[] }
  model?: string
  effort?: string
  agent?: unknown
  meta?: unknown
}

/** Tool prefix Claude Code gives a server: non-ASCII dropped, other invalid characters to `_`. */
export function mcpPrefix(server: string): string {
  const ascii = [...server].filter(c => c.charCodeAt(0) < 128).join('')
  return 'mcp__' + ascii.replace(/[^A-Za-z0-9_-]/g, '_')
}

const pluginName = (id: string) => id.split('@')[0] ?? id

export function makePolicy(data: ProfileData): SkillpoolPolicy {
  const sk = data.skills ?? {}
  const only = sk.only ? [...sk.only, ...(sk.on ?? [])] : null
  return {
    skillsOnly: only,
    others: sk.others ?? 'off',
    skillsOff: sk.off ?? [],
    skillsUserOnly: sk.userOnly ?? [],
    pluginsOff: (data.plugins?.off ?? []).map(pluginName),
    mcpOnly: data.mcp?.only ? data.mcp.only.map(mcpPrefix) : null,
    mcpOff: (data.mcp?.off ?? []).map(mcpPrefix),
  }
}

export type Caller = 'model' | 'person'

/** Whether a skill may run: by the model (Skill tool) or by the person (`/name`). */
export function isSkillAllowed(p: SkillpoolPolicy, name: string, by: Caller): boolean {
  if (name.startsWith('skillpool:')) return true // the profile tools stay reachable
  const plugin = name.includes(':') ? name.split(':')[0] : null
  if (plugin && p.pluginsOff.includes(plugin)) return false
  if (p.skillsOff.includes(name)) return false
  if (p.skillsUserOnly.includes(name)) return by === 'person'
  if (p.skillsOnly === null || p.skillsOnly.includes(name)) return true
  if (p.others === 'off') return false
  if (p.others === 'user-invocable-only') return by === 'person'
  return true // name-only: listed by name, still callable
}

/** Whether a tool may be called; only `mcp__*` tools are ever hidden. */
export function isToolAllowed(p: SkillpoolPolicy, tool: string): boolean {
  if (!tool.startsWith('mcp__') || tool.startsWith('mcp__skillpool__')) return true
  const under = (prefix: string) => tool.startsWith(prefix + '__')
  if (p.pluginsOff.some(pl => under(mcpPrefix(pl)))) return false
  if (p.mcpOff.some(under)) return false
  if (p.mcpOnly !== null) return p.mcpOnly.some(under)
  return true
}

/** Whether a subagent type is offered: a hidden plugin's agents are not. */
export function isAgentAllowed(p: SkillpoolPolicy, agent: string): boolean {
  const plugin = agent.includes(':') ? agent.split(':')[0] : null
  return !(plugin && p.pluginsOff.includes(plugin))
}

/** The `#`/`##` section titled `heading`, through the next heading of the same or higher level. */
export function sectionText(text: string, heading: string): string | null {
  const lines = text.split(/\r?\n/)
  let start = -1
  let level = 0
  let inCode = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trimStart().startsWith('```')) inCode = !inCode
    const m = inCode ? null : /^(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (!m) continue
    const hashes = m[1] ?? ''
    if (start < 0 && m[2] === heading.trim()) {
      start = i
      level = hashes.length
    } else if (start >= 0 && hashes.length <= level) {
      return lines.slice(start, i).join('\n').trim()
    }
  }
  return start >= 0 ? lines.slice(start).join('\n').trim() : null
}

/** What the model is told when the profile is switched on. */
export function profileNote(name: string, data: ProfileData, p: SkillpoolPolicy, appended: string): string {
  const out: string[] = [`[SkillPool] The session now runs under the profile "${name}".`]
  if (data.description) out.push(`Profile: ${data.description}`)
  if (p.skillsOnly !== null) {
    const rest =
      p.others === 'off' ? 'every other skill is switched off'
        : p.others === 'user-invocable-only' ? 'every other skill is for the person to run, not for you'
          : 'other skills stay available'
    out.push(`Skills you may use: ${p.skillsOnly.join(', ') || '(none)'}; ${rest}, even if the skill list still shows it.`)
  }
  if (p.skillsOff.length) out.push(`Switched off: ${p.skillsOff.join(', ')}.`)
  if (p.pluginsOff.length) out.push(`Plugins switched off (their skills, tools and agents): ${p.pluginsOff.join(', ')}.`)
  if (p.mcpOnly !== null) out.push(`MCP tools you may use: only those of ${p.mcpOnly.join(', ') || '(none)'}.`)
  if (p.mcpOff.length) out.push(`MCP tools switched off: those of ${p.mcpOff.join(', ')}.`)
  const ex = data.instructions?.exclude ?? []
  if (ex.length) {
    const what = ex.map(k => (k === 'user' ? "the user's global CLAUDE.md" : k === 'project' ? "this project's CLAUDE.md / AGENTS.md" : k))
    out.push(`Disregard the instructions from ${what.join(' and ')} while this profile is on.`)
  }
  out.push('Calls outside the profile are refused.')
  if (appended) out.push('', 'Profile instructions:', appended)
  return out.join('\n')
}
