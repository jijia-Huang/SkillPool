/** What the mod enforces for a profile; its skills and CLAUDE.md come in through the session link. */
export type SkillpoolPolicy = {
  /** Global skills switched off. */
  skillsOff: string[]
  /** Plugin names (without `@marketplace`) whose skills, tools and agents are refused. */
  pluginsOff: string[]
  /** MCP tool prefixes (`mcp__server`) allowed when the profile names an `only` list; null for none. */
  mcpOnly: string[] | null
  /** MCP tool prefixes refused. */
  mcpOff: string[]
}

/** The profile switched on in this session. */
export type SkillpoolActive = {
  name: string
  policy: SkillpoolPolicy
  /** The profile's memory folder for this project, where the model writes memory instead of Claude Code's own. */
  memory?: string | null
}

/** The session link (`~/.claude/skillpool/sessions/<id>`) this session added as a directory. */
export type SkillpoolLink = {
  path: string
  /** Made by the mod (removed when the session exits), not by the `skillpool` launcher. */
  owned: boolean
}

declare module 'claude-code' {
  interface PluginState {
    skillpool: {
      active: SkillpoolActive | null
      /** The profile `skillpool <profile>` started this session with; its launch settings hold until a restart. */
      launched: string | null
      link: SkillpoolLink | null
    }
  }
}
