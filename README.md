# SkillPool

A Claude Code plugin for organizing your skills, MCP servers, subagents and instruction files (CLAUDE.md / AGENTS.md) into switchable profiles.

把 Claude Code 的 skills、MCP、subagents、指示檔整理成可切換的 profile。

## v0.1：`/skillpool:doctor`

類似 `/doctor`：一叫就掃描你的設定和過去 N 天的實際使用紀錄（`~/.claude/projects/**/*.jsonl`），產出：

1. **健檢**：重複的 MCP、沒生效的 `skillOverrides`、複製到多個專案後走樣的 skill、描述品質、沒在用的 skill / MCP
2. **用量**：哪些 skill / MCP / subagent 最常用、在哪些專案用
3. **分群建議**與 profile 草稿（含估計 token 成本和信心等級）
4. **優化建議**和具體套用方式（優先用原生設定：`skillOverrides`、`/mcp`、`--settings`、`@import`）

全程唯讀，不改任何設定。報告寫在 `~/.claude/skillpool/reports/`（plugin 外面，plugin 更新不會清掉）。

```
/skillpool:doctor
/skillpool:doctor --days 30 只看前端相關
```

## 安裝

在 Claude Code 裡：

```
/plugin install skillpool --marketplace jijia-Huang/SkillPool
```

出現 `Add marketplace?` 時按 `y`，scope 選 user。

或從本機資料夾安裝（開發用，改完檔案在 session 裡跑 `/reload-plugins` 就生效）：

```
git clone https://github.com/jijia-Huang/SkillPool
claude plugin marketplace add ./SkillPool
claude plugin install skillpool@skillpool
```

需要 Python 3.10+（只用標準函式庫）。

## 隱私

掃描只讀本機檔案，不連網。報告只記錄 skill / MCP 的名稱、描述、用量統計和設定狀態；MCP 的 `env`、`headers`、URL query 和命令列參數都不會寫進報告。

## 結構

```
.claude-plugin/        plugin.json、marketplace.json
skills/doctor/         SKILL.md + scripts/scan.py
```

## Roadmap

- `/skillpool <profile>`：session 中途切換 profile（skill 清單、MCP 可見性、指示檔）
- `skillpool_dispatch`：主線依 profile 的 `whenToUse` 選設定，派工給 subagent
- 與其他 agent 啟動器解耦串接：任務標頭 `[profile: x]` → 環境變數 `AGENT_PROFILE`
