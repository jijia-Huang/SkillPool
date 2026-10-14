---
name: profile
description: 管理 SkillPool profile：建立、修改、列出、刪除、檢查 profile，用 profile 開 session，或派工給 skillpool-<profile> subagent。當使用者說「/skillpool:profile」、「建一個 profile」、「改 profile」、「列出 profile」、「這個任務用哪個 profile」、「把 doctor 的草稿存起來」、「用 xx 設定開 claude」時使用。
argument-hint: "[list | show <name> | new <name> <需求> | edit <name> <改什麼> | rm <name> | check <name>]"
---

# SkillPool Profile

profile 決定一個 Claude Code session 看得到哪些 skill、plugin、MCP server 和指示檔。同一個資料夾可以同時開好幾個用不同 profile 的 session。

## 工具

所有操作都透過 SkillPool 的 CLI，**不要直接用 Edit/Write 改 profile 的 JSON 檔**（那會跳過下面的「修改要先給 diff」規則）。

```bash
skillpool <子命令> ...
```

`skillpool` 不在 PATH 上時，改用 `python "<plugin 根目錄>/scripts/skillpool.py" <子命令> ...`。`<plugin 根目錄>` 是這份 SKILL.md 所在資料夾往上兩層。使用者的 CLAUDE.md 有指定 Python 直譯器就用那個。console 只會印 ASCII；中文內容用 `\uXXXX` 表示，或寫在 UTF-8 檔案裡。

| 子命令 | 做什麼 |
|---|---|
| `list [--json]` | 列出這個資料夾看得到的 profile（user 和 project 兩層，同名時 project 優先） |
| `show <name> [--json]` | 這個 profile 會改什麼、實際的 claude 指令、警告。不啟動 claude |
| `show --draft <草稿> --name <name> [--scope ...]` | 同上，但看的是還沒存的草稿（存之前先用這個檢查）。`--scope` 的預設和 `save` 一樣，它也決定相對路徑從哪裡算。有 warning 時 exit code 是 4 |
| `check [<name>]` | 用 headless claude 實際載入一次（約 10 秒），列出真正載入的 skills、MCP、agents、plugins，並更新內建 skill 名稱快取 |
| `save <draft.json> --name <name> [--scope user\|project] [--force]` | 存 profile。見下面的規則。不給 `--scope` 時：同名 profile 已存在就沿用它的層級，否則存到 user 層 |
| `rm <name> [--force]` | 刪 profile 和它產生的 subagent |
| `agents [--dry-run]` | 重新產生所有 `skillpool-<name>` subagent |
| `install-shim` | 在 PATH 上放一個 `skillpool` 指令 |
| `<name> [claude 參數...]` | 用這個 profile 開 claude（給人用的，見「切換」） |

## 寫入規則（使用者的要求，一定要遵守）

- **新的 profile 直接存**：把草稿寫到 scratchpad（或報告資料夾），執行 `skillpool save <草稿> --name <name>`。輸出 `created:` 就完成了。
- **修改既有的 profile 要先給使用者看 diff**：一樣用 `save`、**不加** `--force`。同名 profile 已經存在時，指令會回 exit code 3，把 diff 寫到它印出的檔案路徑，不會改任何東西。用 Read 讀那個 diff 檔，用 ```diff 區塊原樣貼給使用者，問要不要套用。使用者明確同意後才加 `--force` 重跑（會先自動備份舊檔到 `~/.claude/skillpool/backups/profiles/`）。
- **刪除也要先問**：`rm <name>` 不加 `--force` 只會說明會刪什麼；使用者同意後才加 `--force`。
- `save --force` 和 `rm --force` 會寫 `.claude/agents/` 和 `~/.claude/skillpool/backups/`，可能跳出權限確認，或被 auto mode 當成修改設定擋下。被擋時**不要重試或繞過**，把完整指令給使用者自己執行（`! cd "<資料夾>" && skillpool save <草稿> --name <name> --force`），或請使用者放行後再跑。
- 使用者已經在這次對話裡明確說「直接改，不用給我看」時，可以直接 `--force`，但回報時仍要附上 diff 檔的摘要。

這些指令另外會在 `~/.claude/skillpool/` 底下寫快取（`cache/`）、diff 和啟動用的暫存檔（`run/`），以及備份（`backups/`）；這些不是 profile，不用另外問。

`save` 成功後會自動產生或更新 `skillpool-<name>` subagent（user profile 寫到 `~/.claude/agents/`，project profile 寫到 `<專案>/.claude/agents/`）。新的 subagent 從下一個 session 開始出現在 Agent 工具的清單裡。profile 設了 `"agent": false` 就不產生。

## Profile 格式

檔名就是 profile 名稱（小寫英數和 `-`）。所有欄位都可以省略，省略就是不改。

```json
{
  "description": "一句話說這個 profile 是什麼",
  "whenToUse": "什麼任務該用它，寫法像 subagent 的 description（主線會靠它挑 profile）",
  "skills": {
    "only": ["frontend-design", "webapp-testing"],
    "others": "user-invocable-only",
    "on": [], "off": [], "nameOnly": [], "userOnly": []
  },
  "plugins": { "off": ["some-plugin"], "on": [] },
  "mcp": { "only": ["playwright"] },
  "instructions": {
    "exclude": ["user", "project"],
    "append": ["web-rules.md", { "file": "~/.claude/CLAUDE.md", "section": "Code style" }]
  },
  "model": "sonnet",
  "effort": "high",
  "agent": { "preloadSkills": ["frontend-design"], "tools": [], "disallowedTools": [], "model": "sonnet" },
  "meta": { "confidence": "中", "source": "doctor 20261014-093000" }
}
```

- `skills.only`：模型只看得到這些 skill。其他 skill 變成 `others` 指定的模式，預設 `user-invocable-only`（模型看不到，人還能用 `/name` 叫）；可改 `name-only` 或 `off`。使用者原本就設 `off` 的 skill 維持 `off`，profile 不會放寬它。
- `skills.on / off / nameOnly / userOnly`：逐個指定模式，可以和 `only` 一起用。`on` 能把全域設成 `off` 的 skill 在這個 profile 打開。
- **plugin 的 skill（`plugin:skill`）不吃 skillOverrides**，`only` 擋不掉它們，`show` 會警告。要擋就把整個 plugin 放進 `plugins.off`（它的 skills、agents、hooks、MCP 一起停用）。plugin 名稱寫 `name` 或 `name@marketplace` 都可以。
- `mcp.only`：嚴格模式。`"only": []` 代表一個 MCP 都不要（和省略 `mcp` 不同，省略是不改）（`--strict-mcp-config`），只連這些 server，其他的完全不連、工具和 server 說明都不進 context。**claude.ai 的 connectors（Claude Docs、Drive…）在這個模式下全部消失。** mod 自己註冊的工具不是 MCP 設定，會改用隱藏工具的方式擋掉。
- `mcp.off`：只隱藏這些 server 的工具，server 仍會連線，它的 server 說明仍在 system prompt。想完全拿掉就用 `only`。`only` 和 `off` 只能二選一。
- `instructions.exclude`：`"user"` = `~/.claude/CLAUDE.md`（含 `~/.claude/rules/`）；`"project"` = 這個資料夾往上所有的 CLAUDE.md、CLAUDE.local.md、AGENTS.md、`.claude/CLAUDE.md`、`.claude/rules/`，以及子資料夾裡的；其他字串當 glob。CLAUDE.md 和 AGENTS.md 在同一層時 Claude Code 只讀 CLAUDE.md，排除 CLAUDE.md 後 AGENTS.md 會冒出來，所以 `project` 兩個都排除。
- `instructions.append`：加進 system prompt 的內容。字串是檔案路徑，可用 `~`；相對路徑在 **project profile 從專案根目錄算**（例如 `CLAUDE.md`），在 user profile 從 `~/.claude/skillpool/profiles/` 算；`{file, section}` 只取那個 `#`／`##` 標題底下的段落（`section` 寫標題原文）。只要某份指示檔的幾段、不要整份：把那份排除（全域的用 `"user"`，專案的用 `"project"`），再用 `append` 加回那幾段。沒排除就 append 同一份檔案，內容會載入兩次，`show` 會警告。
- `model`、`effort`：這個 profile 開 session 時的預設值；使用者在指令列自己給的參數優先。
- `agent`：產生 `skillpool-<name>` subagent 的設定。`preloadSkills` 會把那幾個 skill 的**全文**預先載入 subagent（每次派工都付這個 token），只放 1～3 個核心的。`tools` 是工具白名單（不給就繼承全部）。`disallowedTools` 額外要擋的工具，只能放工具名稱或 `mcp__<server>`，**不要放 `Skill(x)`**，那會讓整個 Skill 工具消失。
- `meta`：自由欄位（信心等級、來源），程式不讀。

profile 檔位置：user 層在 `~/.claude/skillpool/profiles/<name>.json`（所有專案都看得到），project 層在 `<專案>/.claude/skillpool/profiles/<name>.json`（`save --scope project`）。

## 建立或修改 profile 的步驟

1. `skillpool list --json` 看現有的 profile，避免重複。
2. 弄清楚素材：沒有 doctor 報告時跑 `skillpool check`（看目前實際有哪些 skill、MCP、plugin），需要用量資料就建議使用者先跑 `/skillpool:doctor`。有 doctor 報告就用它的分群和 `profile-<name>.json` 草稿。
3. 寫草稿 JSON（修改時先 Read 現有的 profile 檔，在它的基礎上改），放在 scratchpad 或報告資料夾。
4. **存之前**用 `skillpool show --draft <草稿> --name <name> [--scope ...]` 檢查：`warning` 是要修的（找不到的 skill、檔案、段落、會重複載入的指示檔），`note` 是原生機制的限制。修好草稿再看一次，直到沒有 warning。這樣第一次 `save` 就是最終版，不會一建好就變成「修改」而要再問使用者。
5. 特別看 `note` 裡「plugin skill 擋不掉」那條：使用者要的是「模型只看到這幾個 skill」時，那些 plugin skill 會多出來。先問使用者要不要把那些 plugin 放進 `plugins.off`（副作用：那個 plugin 的 skills、agents、hooks、MCP、`/plugin:*` 指令在這個 profile 裡全部停用），再決定草稿內容。等使用者回答之前**整個 profile 都先不要存**，免得存了又要改。
6. 用 `save` 存（照上面的寫入規則）。想確認實際效果就 `skillpool check <name>`。
7. 回報：存在哪、模型會看到幾個 skill／哪些 MCP、有哪些警告，以及怎麼用（下一節）。

## 切換與派工

- **整個 session 換 profile 只有人能做**：人在終端機執行 `skillpool <name>`，就會在目前資料夾開一個用這個 profile 的新 claude（其他參數照常傳給 claude，例如 `skillpool web-dev -c`）。不要試圖重開或切換自己這個 session，只能建議使用者這樣開。
- `skillpool` 不帶 profile 名稱時讀環境變數 `AGENT_PROFILE`；都沒有就開一般的 claude。用 profile 開的 session 裡 `AGENT_PROFILE` 會是那個 profile 名稱。
- **派工給 subagent**：主線接到任務時，從 Agent 工具的清單挑 description 開頭是 `[SkillPool profile: <name>]`、`Use when` 最符合任務的 `skillpool-<name>`。沒有合適的就用一般 agent，不要硬套。
- subagent 版本的隔離比較弱：它會限制 MCP 和工具、加上 profile 的指示、預載核心 skill，但 **skill 清單和專案的 CLAUDE.md 仍然繼承主線的**。任務需要完整隔離（例如不能被別的 skill 干擾）時，建議使用者另開 `skillpool <name>` 的 session。
- session 中途切換 profile（`/skillpool <name>`）還沒有，規劃在下一版。
