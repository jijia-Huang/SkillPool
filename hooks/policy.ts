// Pure profile logic shared by the hooks: no `$`, so the tests call it directly.
// Mirrors scripts/skillpool.py, which owns the profile folders and the session links.

import type { SkillpoolPolicy } from '../types'

export type ProfileData = {
  description?: string
  whenToUse?: string
  skills?: { use?: string[]; off?: string[] }
  plugins?: { off?: string[]; on?: string[] }
  mcp?: { only?: string[]; off?: string[]; project?: boolean }
  instructions?: { exclude?: string[]; append?: (string | { file: string; section?: string })[] }
  memory?: 'profile' | 'native'
  model?: string
  effort?: string
  agent?: unknown
  meta?: unknown
}

export const MEMORY_HEADING = '## 跨專案記憶'
export const INDEX_START = '<!-- skillpool:memory-index:start -->'
export const INDEX_END = '<!-- skillpool:memory-index:end -->'

/** Tool prefix Claude Code gives a server: non-ASCII dropped, other invalid characters to `_`. */
export function mcpPrefix(server: string): string {
  const ascii = [...server].filter(c => c.charCodeAt(0) < 128).join('')
  return 'mcp__' + ascii.replace(/[^A-Za-z0-9_-]/g, '_')
}

const pluginName = (id: string) => id.split('@')[0] ?? id

/** What the mod enforces for a profile. Its skills and CLAUDE.md come in through the session link instead. */
export function makePolicy(data: ProfileData): SkillpoolPolicy {
  return {
    skillsOff: data.skills?.off ?? [],
    pluginsOff: (data.plugins?.off ?? []).map(pluginName),
    mcpOnly: data.mcp?.only ? data.mcp.only.map(mcpPrefix) : null,
    mcpOff: (data.mcp?.off ?? []).map(mcpPrefix),
  }
}

/** Whether a skill may run (Skill tool or `/name`). */
export function isSkillAllowed(p: SkillpoolPolicy, name: string): boolean {
  if (name.startsWith('skillpool:')) return true // the profile tools stay reachable
  const plugin = name.includes(':') ? name.split(':')[0] : null
  if (plugin && p.pluginsOff.includes(plugin)) return false
  return !p.skillsOff.includes(name)
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

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * The part of `path` inside a profile folder, seen directly (`profiles/<name>/...`) or through a
 * session link (`sessions/<link>/...`); null for any other path.
 */
export function profileRelative(path: string, spHome: string): string | null {
  const p = norm(path)
  for (const area of ['profiles', 'sessions']) {
    const base = `${norm(spHome)}/${area}/`
    if (!p.startsWith(base)) continue
    const rest = p.slice(base.length)
    const slash = rest.indexOf('/')
    return slash < 0 ? '' : rest.slice(slash + 1)
  }
  return null
}

/**
 * Why a write into a profile folder is refused, or null when the model may make it.
 * The model may keep memory (`memory/`, and CLAUDE.md below the memory heading, outside the
 * index SkillPool keeps); rules, profile.json and skill links go through `skillpool save`.
 */
export function writeRefusal(
  rest: string,
  write: { kind: 'edit'; text: string | null; oldStrings: string[]; newStrings: string[] } | { kind: 'write' },
): string | null {
  const save = 'change it with `skillpool save` (the user sees a diff first)'
  if (rest.startsWith('memory/')) return null
  if (rest !== 'claude.md') return `SkillPool: profile files outside memory/ are not edited directly; ${save}.`
  if (write.kind === 'write' || write.text === null) {
    return `SkillPool: the profile's CLAUDE.md is not rewritten whole; edit its "${MEMORY_HEADING.slice(3)}" section, or ${save}.`
  }
  const text = write.text
  const heading = text.indexOf(MEMORY_HEADING)
  const start = text.indexOf(INDEX_START)
  const end = start < 0 ? -1 : text.indexOf(INDEX_END, start) + INDEX_END.length
  for (const old of write.oldStrings) {
    const at = text.indexOf(old)
    if (at < 0) continue // the edit fails on its own
    if (heading < 0 || at < heading + MEMORY_HEADING.length) {
      return `SkillPool: that part of the profile's CLAUDE.md holds its rules; ${save}. Memory goes below "${MEMORY_HEADING}".`
    }
    if (start >= 0 && at < end && at + old.length > start) {
      return 'SkillPool: the memory index is kept by SkillPool; write memory files under memory/ instead.'
    }
  }
  if (write.newStrings.some(s => s.includes(INDEX_START) || s.includes(INDEX_END))) {
    return 'SkillPool: the memory index markers are kept by SkillPool.'
  }
  return null
}
