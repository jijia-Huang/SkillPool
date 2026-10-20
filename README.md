# SkillPool

A Claude Code plugin that turns your skills, instructions and memory into switchable profiles. A profile is a folder that stacks on top of your global and project setup: its own CLAUDE.md, skills picked from a shared pool, its own memory, plus plugin / MCP / model switches.

把 Claude Code 的設定整理成可切換的 profile。profile 是一個資料夾，疊加在你的全域設定和專案設定上面：它自己的 CLAUDE.md（規則與記憶）、從「池子」挑的 skill、自己的記憶，再加上 plugin／MCP／model 的開關。同一個資料夾可以同時開好幾個 profile 不同的 session，session 裡也能隨時切換。

## 包含什麼

| | 做什麼 |
|---|---|
| `/skillpool:doctor` | 掃描設定和過去 N 天的使用紀錄，給健檢、分群建議和 profile 草稿 |
| `/skillpool:profile` | 讓 AI 幫你建立、修改、檢查 profile，把 skill 搬進池子（新的直接建，修改先給 diff） |
| `skillpool <profile>` | 終端機指令：用某個 profile 開 claude（完整效果） |
| `/skillpool <profile>` | session 裡直接切換 profile，不用重開 |

每個 profile 也會自動產生一個 `skillpool-<profile>` subagent，主線可以照 profile 的 `whenToUse` 派工。

## 怎麼運作

```
~/.claude/skillpool/
  pool/<skill>/                      池子：只在某些工作用的 skill（從 ~/.claude/skills 搬過來）
  profiles/<name>/
    CLAUDE.md                        規則 + 跨專案記憶 + 記憶索引（SkillPool 維護的區塊）
    profile.json                     skill、plugin、MCP、model 等開關
    .claude/skills/<skill>           連到池子的捷徑，或只給這個 profile 用的 skill
    memory/<project-key>/MEMORY.md   這個 profile 在某個專案的記憶
  sessions/<id>                      每個 session 一個捷徑，指向它目前用的 profile
```

- **疊加，不取代**：全域的 CLAUDE.md 和 `~/.claude/skills` 照常載入，專案的 CLAUDE.md 和 skill 也照常載入。所以全域只留每個 session 都要的東西，其他的搬進池子，由 profile 加回來。
- **skill：一個 session 一個捷徑**。Claude Code 把 `sessions/<id>` 當成額外的工作目錄（`--add-dir`），讀它的 `.claude/skills`。切換 profile 就是把捷徑改指到另一個 profile 資料夾，再壓縮一次對話。
- **規則與記憶：由 hook 送進對話**。plugin 的 `SessionStart` hook（`skillpool hook session-start`）在 session 開始、每次壓縮後、`/clear` 後，把 profile 的 CLAUDE.md、這個專案的 `MEMORY.md` 和記憶規則放進對話，所以壓縮之後也不會不見。
- **記憶是 profile 自己的，不用 Claude Code 原生的記憶**（原生的按資料夾存）。跨專案的經驗寫在 profile 的 CLAUDE.md「## 跨專案記憶」；特定專案的寫在 `memory/<project-key>/`（一個事實一個檔，`MEMORY.md` 是索引）。用 profile 時原生記憶會被關掉，寫進原生記憶資料夾的動作也會被擋下。模型可以直接寫記憶；改規則區或 profile.json 要先給你看 diff（mod 會擋直接修改）。

## 安裝

需要 Claude Code 和 Python 3.12 以上（只用標準函式庫）。

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

### 2. 安裝 `skillpool` 指令（必要）

Windows（PowerShell）：

```
python "$HOME\.claude\plugins\marketplaces\skillpool\scripts\skillpool.py" install-shim
```

macOS / Linux：

```
python3 ~/.claude/plugins/marketplaces/skillpool/scripts/skillpool.py install-shim
```

- 在 PATH 上的 `~/.local/bin` 或 `~/bin` 放一個 `skillpool` 指令（Windows 另外放 `skillpool.cmd`）。兩個資料夾都不在 PATH 上時，加 `--dir <PATH 上的某個資料夾>`。
- 寫 `~/.claude/skillpool/config.json`，記下用哪個 Python，`/skillpool` 切換時靠它建立捷徑。你用哪個 Python 執行這一行，之後就固定用那個（要用 conda 環境，就用那個環境的 `python.exe`）。
- plugin 的 hook 每個 session 開始時會執行 `skillpool hook session-start`，所以 `skillpool` 一定要在 PATH 上（沒用 profile 的 session，它什麼都不做就結束）。
- 不會改你的 Claude Code 設定。

### 3. 開始用

```
/skillpool:doctor            分析你的設定，給分群建議和 profile 草稿
/skillpool:profile           請 AI 建立或修改 profile、把 skill 搬進池子
skillpool <profile>          在終端機用某個 profile 開 claude
/skillpool <profile>         在 session 裡直接切換
```

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

再刪掉 `~/.local/bin/skillpool`（Windows 還有 `skillpool.cmd`）和 `~/.claude/agents/skillpool-*.md`。池子裡的 skill 先用 `skillpool pool remove <skill> --force` 搬回 `~/.claude/skills`。profile、記憶、報告都在 `~/.claude/skillpool/`。

### 從本機資料夾安裝（開發用）

```
git clone https://github.com/jijia-Huang/SkillPool
claude plugin marketplace add ./SkillPool
claude plugin install skillpool@skillpool
python SkillPool/scripts/skillpool.py install-shim
```

## Profile

建立：`skillpool new <name> --description "..." --when "..."`，或請 `/skillpool:profile` 幫你建。

`profile.json`：

```json
{
  "description": "前端網頁開發",
  "whenToUse": "前端網頁的開發、除錯與瀏覽器測試",
  "skills": { "use": ["frontend-design", "webapp-testing"] },
  "plugins": { "off": ["some-plugin"] },
  "mcp": { "only": ["playwright"] },
  "model": "sonnet",
  "agent": { "preloadSkills": ["frontend-design"] }
}
```

`CLAUDE.md`：這個 profile 的規則、`## 跨專案記憶`，以及 SkillPool 維護的記憶索引區塊。

完整欄位說明在 [`skills/profile/SKILL.md`](skills/profile/SKILL.md)。

| profile 的內容 | 用 `skillpool <profile>` 開 | 用 `/skillpool <profile>` 中途切換 |
|---|---|---|
| `skills.use`、profile 專屬 skill | `--add-dir` 加入 session 捷徑 | 加入或改指 session 捷徑 + 壓縮 |
| CLAUDE.md、這個專案的記憶 | `SessionStart` hook（開始、壓縮後、`/clear` 後） | 切換時直接送進對話，之後由同一個 hook 接手 |
| `plugins.off` | `--settings` 的 `enabledPlugins`（真的不載入） | 擋呼叫（plugin 仍載入） |
| `mcp.only` | `--strict-mcp-config --mcp-config`（只連這些，加上已核准的專案 server） | 擋呼叫、縮短工具說明 |
| `mcp.off` | `permissions.deny: ["mcp__<server>"]` | 擋呼叫 |
| `skills.off`（關掉某個全域 skill） | `skillOverrides` | 擋呼叫 |
| Claude Code 原生記憶 | `autoMemoryEnabled: false` | 擋下寫進 `~/.claude/projects/*/memory/` 的動作 |
| `model`、`effort` | `--model`、`--effort` | 不換 |

## 池子

```
skillpool pool                     池子裡有哪些 skill、各被哪些 profile 使用
skillpool pool add <skill>         把 ~/.claude/skills/<skill> 搬進池子（先說明影響，加 --force 才搬）
skillpool pool remove <skill>      搬回全域
```

搬進池子的 skill，只有用到它的 profile 看得到；沒用 profile 的 session（包括 `claude -p` 腳本）就看不到了。每個 session 都要用的 skill 留在全域。plugin 的 skill 不進池子，用 `plugins.off` 開關整個 plugin。

## `/skillpool`：session 中途切換

```
/skillpool              列出 profile（[on] 是目前的）
/skillpool docs         切到 docs
/skillpool off          關掉 profile
```

- 直接打 `claude` 開的 session 第一次切換時，Claude Code 會問要不要加入 profile 資料夾，選 **Yes, for this session**。之後再切換會自動壓縮一次對話，新 profile 的 CLAUDE.md 和 skill 生效，舊的消失。
- 用 `skillpool <profile>` 開的 session 已經加好捷徑，切換時直接壓縮。開啟時套用的 plugin、MCP、model 要重開才會換，切換時會印出重開的指令（`skillpool <profile> -r <session id>`）。
- profile 關掉的 skill、plugin、MCP 工具，以及停用 plugin 的 subagent 類型，呼叫時一律拒絕；狀態列顯示目前的 profile。

## `skillpool` 指令

```
skillpool <profile> [claude 參數...]   用這個 profile 開 claude
skillpool [claude 參數...]             profile 讀 $AGENT_PROFILE，沒有就開一般的 claude
skillpool list | show <p> | check [<p>]
skillpool new <p> [--description D] [--when W]
skillpool save <draft.json|draft.md> --name <p> [--force]
skillpool rm <p> [--force]
skillpool pool [list] | pool add <skill> | pool remove <skill>
skillpool agents
skillpool install-shim
```

- `check` 會用 headless claude 實際載入一次（約 10 秒），列出真正載入了哪些 skills、MCP、agents、plugins。
- `save` 存新的 profile.json／CLAUDE.md 時直接寫入；已存在時只輸出 diff、exit code 3，加 `--force` 才覆蓋（舊檔先備份到 `~/.claude/skillpool/backups/`）。
- `rm` 把整個 profile 資料夾移到備份區，不直接刪除。
- 啟動時產生的設定檔放在 `~/.claude/skillpool/run/`，claude 結束就刪掉（MCP 設定可能含金鑰）。session 捷徑在 claude 結束時移除；`/skillpool` 建立的捷徑靠心跳檔判斷，停止超過兩小時後由下一次 `skillpool` 指令清掉。
- 派一個獨立的 agent 去做事，profile 一樣完整生效：
  - `skillpool <profile> -p "任務"`：跑完印出結果（headless）。
  - `skillpool <profile> --bg "任務"`：開成背景 session，用 `claude agents`、`claude logs <id>`、`claude attach <id>` 查看。

### 和其他啟動器串接

不需要依賴 SkillPool：任何會開 claude 的工具（例如 agent 編排器）只要

1. 把要用的 profile 名稱放進環境變數 `AGENT_PROFILE`，
2. 把啟動指令從 `claude` 換成 `skillpool`，

就會套用那個 profile；沒裝 SkillPool 時照常用 `claude`。

## `/skillpool:doctor`

類似 `/doctor`：一叫就掃描你的設定和過去 N 天的實際使用紀錄（`~/.claude/projects/**/*.jsonl`），產出：

1. **健檢**：重複的 MCP、沒生效的 `skillOverrides`、複製到多個專案後走樣的 skill、描述品質、沒在用的 skill / MCP
2. **用量**：哪些 skill / MCP / subagent 最常用、在哪些專案用
3. **分群建議**：哪些留在全域、哪些搬進池子，以及每個 profile 的 profile.json 和 CLAUDE.md 草稿
4. **優化建議**和具體套用方式（優先用原生設定）

全程唯讀。報告寫在 `~/.claude/skillpool/reports/`。

```
/skillpool:doctor
/skillpool:doctor --days 30 只看前端相關
```

## 已知限制（Claude Code 2.1.304 實測）

- 組織（Team／Enterprise）管理的 Claude Code 不讓個人安裝的 plugin 改寫 system prompt、skill 清單和 CLAUDE.md，也會略過 mod 的壓縮事件；所以 skill 靠「session 捷徑 + 壓縮」讓 Claude Code 自己重讀，規則與記憶靠傳統的 `SessionStart` hook（這個不受影響）。
- 記憶由模型在對話中自己決定要不要存（照 hook 送的記憶規則），這點跟 Claude Code 原生記憶的官方說明一樣。SkillPool 不會在背景自動合併或清理記憶；`MEMORY.md` 跟原生一樣只載入前 200 行（或 25KB），太長時會提醒模型精簡。
- 中途切換時，Claude Code 會壓縮一次對話（花一點時間和 token）。
- 用 `claude -r` 恢復一個中途切換過的 session 時，profile 不會跟著回來（Claude Code 恢復時不帶回加入的資料夾，也不帶回 mod 的狀態），再打一次 `/skillpool <profile>` 就好。用 `skillpool <profile> -r <id>` 恢復則會直接套用 profile。
- 電腦睡眠超過兩小時，`/skillpool` 建立的捷徑可能被其他 session 的清理拿掉；mod 下一次心跳（10 分鐘內）會自動補回。
- 模型第一次寫 profile 的記憶檔時，可能跳出權限確認（檔案在專案資料夾外面）。
- `mcp.only` 會拿掉所有 claude.ai connectors；`mcp.off` 只藏工具，server 仍會連線。
- plugin 的 skill 不吃 `skillOverrides`，只能整個 plugin 停用。
- 規則是用 Bash 寫檔改掉的話，mod 擋不到（只擋 Edit／Write）。

## 隱私

掃描只讀本機檔案，不連網。報告只記錄 skill / MCP 的名稱、描述、用量統計和設定狀態；MCP 的 `env`、`headers`、URL query 和命令列參數都不會寫進報告。

## 結構

```
.claude-plugin/        plugin.json、marketplace.json
scripts/skillpool.py   skillpool 指令（啟動器、profile、池子、session 捷徑）
skills/doctor/         /skillpool:doctor（SKILL.md + scripts/scan.py）
skills/profile/        /skillpool:profile
hooks/                 mod：/skillpool 切換、擋呼叫、保護 profile 規則（register.ts、policy.ts、測試）
types/                 mod 的 state 型別
tests/                 skillpool.py 的測試（python tests/test_skillpool.py）
docs/                  設計文件
```
