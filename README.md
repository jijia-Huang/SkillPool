# SkillPool

A Claude Code plugin for organizing your skills, MCP servers, subagents and instruction files (CLAUDE.md / AGENTS.md) into switchable profiles.

把 Claude Code 的 skills、MCP、subagents、指示檔整理成可切換的 profile：同一個資料夾可以同時開好幾個設定不同的 session，主線也能依任務挑 profile 派工給 subagent。

## 包含什麼

| | 做什麼 |
|---|---|
| `/skillpool:doctor` | 掃描設定和過去 N 天的使用紀錄，給健檢、分群建議和 profile 草稿 |
| `/skillpool:profile` | 讓 AI 幫你建立、修改、檢查 profile（新的直接存，修改先給 diff） |
| `skillpool <profile>` | 終端機指令：用某個 profile 開 claude |
| `/skillpool <profile>` | session 裡直接切換 profile，不用重開 |

每個 profile 也會自動產生一個 `skillpool-<profile>` subagent，主線可以照 profile 的 `whenToUse` 派工。

## 安裝

需要 Claude Code 和 Python 3.10 以上（只用標準函式庫）。

### 1. 安裝 plugin

在 Claude Code 裡輸入：

```
/plugin install skillpool --marketplace jijia-Huang/SkillPool
```

出現 `Add marketplace?` 時按 `y`，scope 選 **user**。也可以在終端機裝：

```
claude plugin marketplace add jijia-Huang/SkillPool
claude plugin install skillpool@skillpool
```

裝好後開新的 session（或在目前的 session 跑 `/reload-plugins`），就有 `/skillpool:doctor`、`/skillpool:profile` 和 `/skillpool`。

### 2. 安裝 `skillpool` 終端機指令

要用 `skillpool <profile>` 從終端機開 session 才需要這一步。

Windows（PowerShell）：

```
python "$HOME\.claude\plugins\marketplaces\skillpool\scripts\skillpool.py" install-shim
```

macOS / Linux：

```
python3 ~/.claude/plugins/marketplaces/skillpool/scripts/skillpool.py install-shim
```

- 會在 PATH 上的 `~/.local/bin` 或 `~/bin` 放一個 `skillpool` 指令（Windows 另外放 `skillpool.cmd`）。兩個資料夾都不在 PATH 上時，加 `--dir <PATH 上的某個資料夾>`。
- 你用哪個 Python 執行這一行，`skillpool` 之後就固定用那個 Python。要用 conda 環境，就用那個環境的 `python.exe` 執行。
- 指令指向 marketplace 的那份 clone，plugin 更新後不用重裝。
- 開一個新的終端機，`skillpool list` 有輸出就裝好了。

### 3. 開始用

```
/skillpool:doctor            分析你的設定，給分群建議和 profile 草稿
/skillpool:profile           請 AI 建立或修改 profile（例如把 doctor 的草稿存起來）
skillpool <profile>          在終端機用某個 profile 開 claude
/skillpool <profile>         在 session 裡直接切換
```

要用 `skills.only` 的話，先在終端機跑一次 `skillpool check`，它會記下內建 skill 的名稱，profile 才擋得到它們。

### 更新

```
claude plugin marketplace update skillpool
claude plugin update skillpool@skillpool
```

然後在 session 裡跑 `/reload-plugins`，或開新的 session。

### 解除安裝

```
claude plugin uninstall skillpool@skillpool
claude plugin marketplace remove skillpool
```

再刪掉 `~/.local/bin/skillpool`（Windows 還有 `skillpool.cmd`）和 `~/.claude/agents/skillpool-*.md`（profile 產生的 subagent）。profile、報告、快取都在 `~/.claude/skillpool/`，不要了也可以一起刪。

### 從本機資料夾安裝（開發用）

```
git clone https://github.com/jijia-Huang/SkillPool
claude plugin marketplace add ./SkillPool
claude plugin install skillpool@skillpool
python SkillPool/scripts/skillpool.py install-shim
```

改完檔案，在 session 裡跑 `/reload-plugins` 就生效。

## `/skillpool:doctor`

類似 `/doctor`：一叫就掃描你的設定和過去 N 天的實際使用紀錄（`~/.claude/projects/**/*.jsonl`），產出：

1. **健檢**：重複的 MCP、沒生效的 `skillOverrides`、複製到多個專案後走樣的 skill、描述品質、沒在用的 skill / MCP
2. **用量**：哪些 skill / MCP / subagent 最常用、在哪些專案用
3. **分群建議**與 profile 草稿（含估計 token 成本和信心等級），草稿可以直接存成 profile
4. **優化建議**和具體套用方式（優先用原生設定）

全程唯讀。報告寫在 `~/.claude/skillpool/reports/`。

```
/skillpool:doctor
/skillpool:doctor --days 30 只看前端相關
```

## Profile

profile 是一個 JSON 檔：

- user 層：`~/.claude/skillpool/profiles/<name>.json`
- project 層：`<專案>/.claude/skillpool/profiles/<name>.json`

```json
{
  "description": "前端網頁開發",
  "whenToUse": "前端網頁的開發、除錯與瀏覽器測試",
  "skills": { "only": ["frontend-design", "webapp-testing", "verify"] },
  "mcp": { "only": ["playwright"] },
  "plugins": { "off": ["some-plugin"] },
  "instructions": {
    "exclude": ["user"],
    "append": ["web-rules.md", { "file": "~/.claude/CLAUDE.md", "section": "Code style" }]
  },
  "model": "sonnet",
  "agent": { "preloadSkills": ["frontend-design"] }
}
```

完整欄位說明在 [`skills/profile/SKILL.md`](skills/profile/SKILL.md)。

全部用 Claude Code 原生的機制，不改你的全域設定：

| profile 欄位 | 對應的原生機制 |
|---|---|
| `skills.only` / `on` / `off` / `nameOnly` / `userOnly` | `--settings` 裡的 `skillOverrides`（和全域設定合併；`only` 以外的 skill 預設關掉；設 `"others": "user-invocable-only"` 則只對模型藏起來，人還能用 `/` 叫） |
| `plugins.off` | `--settings` 裡的 `enabledPlugins` |
| `mcp.only` | `--strict-mcp-config --mcp-config`（只連這些 server） |
| `mcp.off` | `permissions.deny: ["mcp__<server>"]`（只藏工具） |
| `instructions.exclude` | `claudeMdExcludes` |
| `instructions.append` | `--append-system-prompt-file` |

### 已知限制（Claude Code 2.1.296 實測）

- plugin 的 skill 不吃 `skillOverrides`，只能整個 plugin 停用。
- `mcp.only` 會拿掉所有 claude.ai connectors；`mcp.off` 只藏工具，server 仍會連線，它的說明仍在 system prompt。
- 同一層同時有 CLAUDE.md 和 AGENTS.md 時，Claude Code 只讀 CLAUDE.md。
- 接續舊對話（`skillpool <profile> -c` / `-r`）時，Claude Code 預設會沿用舊對話記錄下來的 system prompt；`skillpool` 會自動加 `--system-prompt-snapshot off`，讓新 profile 的指示生效。
- `user-invocable-only` 的 skill：人可以用 `/name` 叫，模型自己呼叫會被拒絕（實測）。
- `skillpool-<profile>` subagent：MCP／工具照 profile 限制；profile 排除了全域和專案指示檔時，subagent 不讀任何 CLAUDE.md（`omitClaudeMd`），只用 profile 的指示；profile 以外的 skill 由 SkillPool 的 mod 擋下。但 **skill 清單本身仍是主線那份**（看得到、用了被擋），Claude Code 沒有提供 subagent 的 skill 白名單。要清單真的變短，另開 `skillpool <profile>` 的 session。

## `skillpool` 指令

```
skillpool <profile> [claude 參數...]   用這個 profile 開 claude
skillpool [claude 參數...]             profile 讀 $AGENT_PROFILE，沒有就開一般的 claude
skillpool list | show <p> | check [<p>]
skillpool save <draft.json> --name <p> [--scope user|project] [--force]
skillpool rm <p> [--force]
skillpool agents
skillpool install-shim
```

- `check` 會用 headless claude 實際載入一次（約 10 秒），列出真正載入了哪些 skills、MCP、agents、plugins。
- `save` 存新 profile 時直接寫入；同名已存在時只輸出 diff、exit code 3，加 `--force` 才覆蓋（舊檔先備份到 `~/.claude/skillpool/backups/`）。
- 用 profile 開的 session，環境變數 `AGENT_PROFILE` 會是 profile 名稱。
- 啟動時產生的設定檔放在 `~/.claude/skillpool/run/`，claude 結束就刪掉（MCP 設定可能含金鑰）。

### 和其他啟動器串接

不需要依賴 SkillPool：任何會開 claude 的工具（例如 agent 編排器）只要

1. 把要用的 profile 名稱放進環境變數 `AGENT_PROFILE`（慣例：任務開頭寫 `[profile: <name>]`，由編排器轉成環境變數），
2. 把啟動指令從 `claude` 換成 `skillpool`，

就會套用那個 profile；沒裝 SkillPool 時照常用 `claude`。

## 隱私

掃描只讀本機檔案，不連網。報告只記錄 skill / MCP 的名稱、描述、用量統計和設定狀態；MCP 的 `env`、`headers`、URL query 和命令列參數都不會寫進報告。

## 結構

```
.claude-plugin/        plugin.json、marketplace.json
scripts/skillpool.py   skillpool 指令（啟動器 + profile 管理）
skills/doctor/         /skillpool:doctor（SKILL.md + scripts/scan.py）
skills/profile/        /skillpool:profile
hooks/                 mod：/skillpool 切換（register.ts、policy.ts、測試）
types/                 mod 的 state 型別
```

## `/skillpool`：session 中途切換

```
/skillpool              列出 profile（[on] 是目前的）
/skillpool docs         切到 docs
/skillpool off          關掉 profile
```

由 plugin 裡的 mod（`hooks/`）處理，切換後立刻生效：

- profile 以外的 skill（模型的 Skill 工具、人打的 `/name`）、MCP 工具、停用 plugin 的 subagent 類型一律拒絕，subagent 的呼叫也一樣。
- 模型會收到一則說明：現在能用哪些 skill／MCP，以及 profile 的 `instructions.append`。
- 被隱藏的 MCP 工具，描述縮成一行「已停用」。
- 狀態列顯示目前的 profile。

和 `skillpool <profile>` 重開的差別：

| | `skillpool <profile>` 重開 | `/skillpool <profile>` 切換 |
|---|---|---|
| 不用中斷 | ✗ | ✓ |
| 擋掉 profile 以外的呼叫 | ✓ | ✓ |
| skill 清單、CLAUDE.md 真的從 context 拿掉 | ✓ | ✗（已讀的留著，模型被告知不要用） |
| MCP server 不連線 | ✓（`mcp.only`） | ✗（連著，但工具被擋） |

切換不能真的改寫 skill 清單和 CLAUDE.md，是因為組織（Team／Enterprise）管理的 Claude Code 不讓個人安裝的 plugin 改寫它們。用 `skillpool <profile>` 開的 session 再切到別的 profile 時，開啟時關掉的東西不會回來；要完整換就照指令輸出的 `skillpool <profile> -r <session id>` 重開。

## Roadmap

- 沒有組織管理的環境：切換時直接改寫 skill 清單和 CLAUDE.md
- subagent 的 skill 清單也依 profile 過濾（Claude Code 目前沒有原生作法；組織管理的帳號也不讓個人 plugin 改寫清單）
