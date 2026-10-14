/** What a profile allows, computed once when the profile is switched on. */
export type SkillpoolPolicy = {
  /** Skills the model may use when the profile names an `only` list (`only` plus `on`); null for none. */
  skillsOnly: string[] | null
  /** What happens to skills outside `skillsOnly`. */
  others: 'off' | 'user-invocable-only' | 'name-only'
  /** Skills switched off outright. */
  skillsOff: string[]
  /** Skills the model may not call but the person may run as `/name`. */
  skillsUserOnly: string[]
  /** Plugin names (without `@marketplace`) whose skills, tools and agents are hidden. */
  pluginsOff: string[]
  /** MCP tool prefixes (`mcp__server`) allowed when the profile names an `only` list; null for none. */
  mcpOnly: string[] | null
  /** MCP tool prefixes hidden. */
  mcpOff: string[]
}

/** The profile switched on in this session. */
export type SkillpoolActive = {
  name: string
  /** `user` or `project`: where the profile file was found. */
  scope: string
  policy: SkillpoolPolicy
}

declare module 'claude-code' {
  interface PluginState {
    skillpool: {
      active: SkillpoolActive | null
      /** The profile `skillpool <profile>` started this session with; its settings hold until a restart. */
      launched: string | null
    }
  }
}
