---
name: profile
description: 管理 SkillPool profile：建立、修改、列出、刪除、檢查 profile，把 skill 搬進池子，用 profile 開 session，或派工給 skillpool-<profile> subagent。當使用者說「/skillpool:profile」、「建一個 profile」、「改 profile」、「列出 profile」、「這個任務用哪個 profile」、「把 doctor 的草稿存起來」、「把 skill 搬進池子」、「用 xx 設定開 claude」時使用。
argument-hint: "[list | show <name> | new <name> <需求> | edit <name> <改什麼> | rm <name> | pool]"
---

# SkillPool Profile

profile 是一個資料夾，疊加在使用者的全域設定和專案設定上面：它自己的 CLAUDE.md（規則與跨專案記憶）、每個專案的記憶、從池子挑的 skill，再加上 plugin／MCP／model 這些開關。同一個資料夾可以同時開好幾個用不同 profile 的 session。

profile 的 CLAUDE.md、這個專案的 `MEMORY.md` 和記憶規則，由 SkillPool 的 `SessionStart` hook 在 session 開始、壓縮後、`/clear` 後送進對話。用 profile 時 Claude Code 原生的記憶不用（原生的按資料夾存），寫進 `~/.claude/projects/*/memory/` 會被擋下。

```
~/.claude/skillpool/
  pool/<skill>/                      池子：專用 skill 的本體（從 ~/.claude/skills 搬過來）
  profiles/<name>/
    CLAUDE.md                        規則 + 跨專案記憶 + 記憶索引（SkillPool 維護的區塊）
    profile.json                     skill、plugin、MCP、model 等開關
    .claude/skills/<skill>           連到池子的捷徑，或只給這個 profile 用的 skill 實體
    memory/<project-key>/MEMORY.md   這個 profile 在某個專案的記憶
  sessions/<id>                      每個 session 一個捷徑，指向它目前用的 profile
```

## 工具

所有操作都透過 SkillPool 的 CLI：

```bash
skillpool <子命令> ...
```

`skillpool` 不在 PATH 上時，改用 `python "<plugin 根目錄>/scripts/skillpool.py" <子命令> ...`。`<plugin 根目錄>` 是這份 SKILL.md 所在資料夾往上兩層。使用者的 CLAUDE.md 有指定 Python 直譯器就用那個。console 只會印 ASCII；中文內容用 `\uXXXX` 表示，或寫在 UTF-8 檔案裡。

| 子命令 | 做什麼 |
|---|---|
| `list [--json]` | 列出所有 profile |
| `show <name> [--json]` | 這個 profile 在目前資料夾會做什麼、實際的 claude 指令、警告、中途切換做不到的事。不啟動 claude |
| `show --draft <profile.json 草稿> --name <name>` | 同上，看還沒存的草稿。有 warning 時 exit code 是 4 |
| `check [<name>]` | 用 headless claude 實際載入一次（約 10 秒），列出真正載入的 skills、MCP、agents、plugins |
| `new <name> [--description D] [--when W]` | 建立新的 profile 資料夾（profile.json、CLAUDE.md 範本、memory/） |
| `save <草稿.json\|草稿.md> [--name <name>] [--force]` | 存 profile.json 或 CLAUDE.md。見寫入規則 |
| `rm <name> [--force]` | 把 profile 資料夾整個移到備份區，並移除它產生的 subagent |
| `pool [list]` | 池子裡有哪些 skill、各被哪些 profile 使用 |
| `pool add <skill> [--force]` / `pool remove <skill> [--force]` | 把 skill 從 `~/.claude/skills` 搬進池子／搬回全域 |
| `agents [--dry-run]` | 重新產生所有 `skillpool-<name>` subagent |
| `install-shim` | 在 PATH 上放 `skillpool` 指令（plugin 的 hook 會用到它） |
| `<name> [claude 參數...]` | 用這個 profile 開 claude（給人用的，見「切換」） |

## 寫入規則（使用者的要求，一定要遵守）

- **新的 profile 直接建**：`skillpool new <name> --description "..."`，或把 profile.json 草稿寫到 scratchpad 再 `skillpool save <草稿> --name <name>`。新的 profile.json 和新的 CLAUDE.md 直接寫入。
- **修改既有的 profile.json 或 CLAUDE.md 規則區，要先給使用者看 diff**：用 `save`、**不加** `--force`。指令回 exit code 3，把 diff 寫到它印出的檔案路徑，不改任何東西。用 Read 讀 diff 檔，用 ```diff 區塊原樣貼給使用者，問要不要套用；使用者明確同意後才加 `--force` 重跑（會先備份到 `~/.claude/skillpool/backups/profiles/`）。改 CLAUDE.md 時，先 Read 現有的檔，在它的基礎上寫草稿 `.md`，再 `save <草稿.md> --name <name>`；記憶索引區塊由 SkillPool 自己更新，diff 不會顯示它。
- **記憶可以直接寫**：`memory/` 底下的檔案，以及 CLAUDE.md「## 跨專案記憶」標題以下、記憶索引區塊以外的內容，模型可以直接用 Edit／Write 修改，不用問。SkillPool 的 mod 會擋掉直接改規則區、profile.json、skill 捷徑和記憶索引的動作。
- **刪除和搬移 skill 要先問**：`rm <name>`、`pool add`、`pool remove` 不加 `--force` 只會說明會做什麼；使用者同意後才加 `--force`。
- `--force` 的指令會寫 `~/.claude/` 底下的檔案，可能跳出權限確認，或被 auto mode 當成修改設定擋下。被擋時**不要重試或繞過**，把完整指令給使用者自己執行（`! skillpool save <草稿> --name <name> --force`），或請使用者放行後再跑。
- 使用者已經在這次對話裡明確說「直接改，不用給我看」時，可以直接 `--force`，但回報時仍要附上 diff 檔的摘要。

這些指令另外會在 `~/.claude/skillpool/` 底下寫快取（`cache/`）、diff 和啟動用的暫存檔（`run/`）、session 捷徑（`sessions/`）以及備份（`backups/`）；這些不是 profile，不用另外問。

`new` 和 `save` 成功後會自動產生或更新 `~/.claude/agents/skillpool-<name>.md` subagent，從下一個 session 開始出現在 Agent 工具的清單裡。profile.json 設了 `"agent": false` 就不產生。

## profile.json 格式

所有欄位都可以省略，省略就是不改。

```json
{
  "description": "一句話說這個 profile 是什麼",
  "whenToUse": "什麼任務該用它，寫法像 subagent 的 description（主線會靠它挑 profile）",
  "skills": { "use": ["frontend-design", "webapp-testing"], "off": [] },
  "plugins": { "off": ["some-plugin"], "on": [] },
  "mcp": { "only": ["playwright"], "project": true },
  "model": "sonnet",
  "effort": "high",
  "agent": { "preloadSkills": ["frontend-design"], "tools": [], "disallowedTools": [], "model": "sonnet" },
  "meta": { "confidence": "中", "source": "doctor 20261020-093000" }
}
```

- `skills.use`：要從池子加進這個 profile 的 skill。`save` 會在 profile 的 `.claude/skills/` 建好捷徑。池子裡沒有的 skill 先用 `pool add` 搬進去。全域 skill（`~/.claude/skills`）和專案 skill 本來就在，不用列。
- `skills.off`：選用，關掉某個全域 skill。用 `skillpool` 啟動時真的拿掉；中途切換時只能擋呼叫。
- **plugin 的 skill 不進池子**，用 `plugins.off` 關掉整個 plugin（它的 skills、agents、hooks、MCP 一起停用）。plugin 名稱寫 `name` 或 `name@marketplace` 都可以。`skillpool` 自己放進 `plugins.off` 會被略過。
- `mcp.only`：嚴格模式，只連這些 server（`"only": []` 代表一個都不要）。專案 `.mcp.json` 裡**使用者核准過**的 server 預設會一起保留；`"project": false` 則不要專案的 server。**claude.ai 的 connectors 在這個模式下全部消失。**
- `mcp.off`：只隱藏這些 server 的工具，server 仍會連線。`only` 和 `off` 只能二選一。
- `model`、`effort`：這個 profile 開 session 時的預設值；使用者在指令列自己給的參數優先。
- `agent`：產生 `skillpool-<name>` subagent 的設定。`preloadSkills` 會把那幾個 skill 的**全文**預先載入 subagent，只放 1～3 個核心的。`tools` 是工具白名單（不給就繼承全部）。`disallowedTools` 只能放工具名稱或 `mcp__<server>`，**不要放 `Skill(x)`**，那會讓整個 Skill 工具消失。
- `instructions.append` / `instructions.exclude`：進階選項，只在啟動時有效。規則請直接寫在 profile 的 CLAUDE.md。
- `meta`：自由欄位，程式不讀。

`show` 的 `note` 若提到「某份指示檔用了池子裡的 skill X，但這個 profile 沒有」，代表專案或全域的規則會叫到這個 skill：告訴使用者，要的話把它加進 `skills.use`（不要自動加，profile 是所有專案共用的）。

## 建立或修改 profile 的步驟

1. `skillpool list --json` 和 `skillpool pool list` 看現有的 profile 和池子。
2. 弄清楚素材：沒有 doctor 報告時跑 `skillpool check`，需要用量資料就建議使用者先跑 `/skillpool:doctor`。有 doctor 報告就用它的分群和草稿。
3. 新的 profile：`skillpool new <name> --description "..." --when "..."`，再寫 profile.json 草稿（`skills.use` 等）和 CLAUDE.md 草稿（規則），用 `save` 存。修改：先 Read 現有檔案，在它的基礎上改。
4. **存 profile.json 之前**用 `skillpool show --draft <草稿> --name <name>` 檢查：`warning` 要修（池子裡沒有的 skill、找不到的 plugin），`note` 是限制與提醒。
5. 需要的 skill 還在 `~/.claude/skills` 時，問使用者要不要 `pool add` 搬進池子（副作用：沒用這個 profile 的 session 就看不到它）。
6. 用 `save` 存（照上面的寫入規則）。想確認實際效果就 `skillpool check <name>`。
7. 回報：存在哪、這個 profile 加了哪些 skill、關了哪些 plugin／MCP、有哪些警告，以及怎麼用（下一節）。

## 切換與派工

- **用 profile 開新 session**：人在終端機執行 `skillpool <name>`（其他參數照常傳給 claude，例如 `skillpool web-dev -c`）。這是完整效果：profile 的 CLAUDE.md、記憶與 skill、plugin 開關、MCP 範圍、model 全部生效。`skillpool` 不帶名稱時讀環境變數 `AGENT_PROFILE`；都沒有就是一般的 claude。
- **session 中途切換**：人在 session 裡打 `/skillpool <name>`（`/skillpool` 列出 profile，`/skillpool off` 關掉）。這是給人用的指令；你不要自己切，只能建議使用者打。
  - 一般 `claude` 開的 session 第一次切換時，Claude Code 會問要不要加入 profile 資料夾，選「Yes, for this session」。之後再切換會自動壓縮一次對話，讓新 profile 的 CLAUDE.md 和 skill 生效、舊的消失。
  - 中途切換做不到的事（plugin 真的卸載、MCP 斷線、換 model）只會變成「擋呼叫」或提示；`show` 會列出來。要全部生效，用 `skillpool <name>` 開新的 session。
- **派一個完整隔離的 agent**：用 Bash 跑原生的 headless 或背景 session。
  - `skillpool <name> -p "任務"`：跑完把結果印回來。
  - `skillpool <name> --bg "任務"`：背景執行，回報它印出的 id，之後用 `claude logs <id>` 看進度、`claude attach <id>` 接手。
  - 這會花另一個 session 的額度，只在使用者要你派工、或任務明顯需要乾淨設定時用。
- **派工給 subagent**：從 Agent 工具的清單挑 description 開頭是 `[SkillPool profile: <name>]`、`Use when` 最符合任務的 `skillpool-<name>`。它會先讀 profile 的 CLAUDE.md、照記憶索引讀寫記憶；profile 關掉的 skill、plugin、MCP 被呼叫時由 SkillPool 擋下。沒有合適的就用一般 agent，不要硬套。
