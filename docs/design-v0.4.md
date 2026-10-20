# SkillPool v0.4 設計：profile 資料夾、skill 池、連結切換

狀態：已實作（2026-10-20，plugin 0.4.0）。實測環境 Claude Code 2.1.296 → 2.1.304，Team 帳號（組織政策 plugin `cc-plugin-sec-default` 生效）。
結構參考 [claudeclaw](https://github.com/moazbuilds/claudeclaw)：一個資料夾就是一個 agent，CLAUDE.md 就是它的持久記憶。

## 1. 已確定的決定

| # | 決定 |
|---|---|
| 1 | **疊加，不取代**：全域層照常載入，由使用者自己保持精簡；profile 疊加在上面；專案層照舊 |
| 2 | **profile = 一個資料夾** `profiles/<name>/`，裡面有 CLAUDE.md、設定、skill、記憶，不經過組裝 |
| 3 | **全部走 add-dir**：每個 session 加入一個連結 `sessions/<id>`，連結指向 profile 資料夾；切換 = 改連結目標 + 壓縮 |
| 4 | skill 池：專用 skill 搬進池子，profile 用 junction 從池子挑；全域只留常駐 skill |
| 5 | plugin 不搬進池子，由 profile 開關整個 plugin |
| 6 | 記憶：跨專案的寫在 profile 的 CLAUDE.md，特定專案的寫在 `memory/<project-key>/`；CLAUDE.md 裡有自動維護的記憶索引 |
| 7 | 寫入權限：記憶模型可以直接寫；規則區與 `profile.json` 修改要先給使用者看 diff，mod 擋直接修改 |
| 8 | 專案自己的 skill 全部保留 |
| 9 | 專案 `.mcp.json`：profile 可設定用或不用，預設用 |
| 10 | 專案 CLAUDE.md 明確引用的池子 skill（`/name`、`.claude/skills/name`、`.agents/skills/name`）自動加入 |
| 11 | herdr-commander 不改（解耦方式之後再想） |
| 12 | 池子用**搬移**：skill 從 `~/.claude/skills` 搬進池子 |
| 13 | **沒有預設 profile**：不帶 profile 就是一般 Claude Code 的行為 |
| 14 | **不需要 `claude` 別名**：一般 session 用 `/skillpool <name>` 就能切換；要啟動限定的項目時才用 `skillpool <name>` 啟動 |
| 15 | **只有使用者層 profile**：拿掉專案層 profile（`<project>/.claude/skillpool/profiles/`） |
| 16 | 環境變數 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`：SkillPool 安裝步驟（`install-shim`）詢問使用者同意後寫入 `~/.claude/settings.json` 的 `env`，先備份；`skillpool` 啟動時另外直接帶給子行程 |
| 17 | session 連結在 session 結束時刪除，當機留下的下次啟動時清掉 |
| 18 | **記憶完全由 SkillPool 自己管**（參考 mempalace 的分層）：profile 的 CLAUDE.md（L0 身分與規則、跨專案記憶）＋這個專案的 `MEMORY.md`（L1）由傳統 `SessionStart` hook 在開始／壓縮後／`/clear` 後送進對話；L2 各記憶檔照索引按需讀；L3 搜尋之後再做。原生記憶在 profile session 關閉並擋寫。因此不再需要全域環境變數（取代 #16） |

## 2. 分層模型

| 層 | 內容 | 有 profile 時 |
|---|---|---|
| 全域層 | `~/.claude/CLAUDE.md`、`~/.claude/skills`（只留常駐的）、內建 skill | 照常載入 |
| profile 層 | `profiles/<name>/`：CLAUDE.md + `.claude/skills` | 透過 `sessions/<id>` 連結疊加 |
| 專案層 | 專案 CLAUDE.md / AGENTS.md、專案 `.claude/skills`、專案 `.mcp.json` | 照常載入 |
| 啟動限定 | plugin 開關、MCP 範圍、model / effort、原生記憶位置 | 只有 `skillpool <profile>` 啟動時完整生效 |

## 3. 目錄結構

```
~/.claude/skillpool/
  pool/<skill>/                       ← 池子：skill 本體
  profiles/<name>/                    ← 一個 profile 一個資料夾
    CLAUDE.md                         ← 規則 + 跨專案記憶 + 記憶索引（自動維護區塊）
    profile.json                      ← plugin、MCP、model、effort、memory、agent 等開關
    .claude/skills/<skill>            ← junction 到 pool/<skill>/；只給這個 profile 用的也可以直接放實體
    memory/<project-key>/MEMORY.md …  ← 每個專案一份記憶
  sessions/<session-id>               ← junction，指向目前使用的 profiles/<name>/
```

`project-key`：專案根目錄路徑把非英數字元換成 `-`（`D:\Tool\App` → `D--Tool-App`）。

## 4. profile 資料夾內容

### CLAUDE.md（參考 claudeclaw 的「CLAUDE.md 即記憶」）

```markdown
# docs profile
用途、規則、做事方式……（規則區：修改要給使用者看 diff）

## 跨專案記憶
這個 profile 在所有專案都適用的經驗（模型直接更新）

<!-- skillpool:memory-index:start -->
- D--Tool-App：memory/D--Tool-App/MEMORY.md（最後使用 2026-10-20）
<!-- skillpool:memory-index:end -->
```

- 記憶索引區塊由 SkillPool 在啟動與切換時更新，只改兩個標記之間，不碰其他內容。不依賴 `@import`。
- 新建：`skillpool new <name>` 建好資料夾與 CLAUDE.md 範本，`/skillpool:profile` 用對話幫使用者填內容（類似 claudeclaw 的 BOOTSTRAP）。

### 寫入規則（mod 在 `tool.call` 檢查）
| 位置 | 模型可否直接寫 |
|---|---|
| `memory/` 底下 | 可以 |
| CLAUDE.md「## 跨專案記憶」標題之後、索引區塊之外的編輯 | 可以（mod 比對 Edit 的 `old_string` 位置） |
| CLAUDE.md 規則區、整份覆寫（Write） | 擋下，改走 `skillpool save`（出 diff、使用者同意後 `--force`） |
| 記憶索引區塊 | 擋下（SkillPool 自己維護） |
| `profile.json`、`.claude/skills/` | 擋下，改走 `skillpool save` / `skillpool pool` |

### profile.json
```json
{
  "description": "文件撰寫",
  "whenToUse": "寫 wiki、Word、PDF 文件時",
  "skills": { "use": ["wiki-archive", "pdf"], "off": [] },
  "plugins": { "off": ["some-plugin"] },
  "mcp": { "only": [], "project": true },
  "model": "sonnet",
  "effort": "medium",
  "memory": "profile",
  "agent": {}
}
```
- `skills.use`：要從池子連進 `.claude/skills/` 的 skill（`skillpool save` 依此建立／移除 junction）。取代 v0.3 的 `skills.only` / `skills.others`。
- `skills.off`：選用，關掉某個全域 skill（啟動時用 `skillOverrides`；中途切換時擋呼叫）。
- `memory`：`"profile"`（預設，原生記憶改到 `memory/<project-key>/`）或 `"native"`（不換）。
- `instructions.append` / `instructions.exclude` 保留為進階選項（`exclude` 只在啟動時有效）。

## 5. 連結切換（已實測）

每個 session 只加入一個路徑 `sessions/<session-id>`，它是指向 profile 資料夾的 junction：

1. 開始用 profile：建立 `sessions/<id>` → `profiles/docs/`，加入 session（add-dir）。
2. 切換到 spine：把 `sessions/<id>` 改指到 `profiles/spine/`，然後壓縮一次。
3. Claude Code 讀的一直是同一個路徑，壓縮時重新讀到的就是 spine 的 CLAUDE.md 和 skill。

實測（2.1.304）：Claude Code 記錄的是連結路徑而不是目標；改指向後壓縮，新 profile 的 CLAUDE.md 載入、新 skill 出現且可呼叫、舊 skill 從清單消失且呼叫回 Unknown skill；用 `cmd /c rmdir` 拿掉連結，舊 profile 的檔案完好。

為什麼不直接加入 `profiles/<name>/`：中途沒辦法（或尚未驗證能）移除已加入的資料夾，兩個 profile 會疊在一起；而且同時開的兩個 session 可能用不同 profile，各自需要一個指標。

需要環境變數 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`：
- `skillpool` 啟動：啟動器放進子行程的環境變數。
- 一般 `claude`：寫進 `~/.claude/settings.json` 的 `env`，由 `skillpool install-shim` 詢問同意後寫入（先備份）。副作用：之後用 `/add-dir` 加入的任何資料夾，它的 CLAUDE.md 也都會載入。

**連結刪除規則（防止刪掉 profile 或池子的原檔）**：Windows 上對含 junction 的資料夾做遞迴刪除（例如 Python 3.12 以前的 `shutil.rmtree`）會穿過 junction 刪掉目標的真實檔案。所以：
- 移除 `sessions/<id>` 或 `.claude/skills/<skill>` 一律只拿掉連結本身（`os.rmdir` / `cmd /c rmdir`），先確認它是連結。
- 絕不對 `sessions/` 或 profile 資料夾做遞迴刪除。mod 端 `$.fs` 的刪除語意未知，先實測；不確定就交給 Python 啟動器。
- 測試必須包含 junction，並驗證刪除後目標檔案還在。

清理：連結本身沒有內容，session 結束時（mod 的 session 結束事件、啟動器退出時）就移除；當機留下的，下次啟動時掃掉「對應 session 已不存在」的連結。

## 6. 兩種開法

profile 的 CLAUDE.md 與 skill 兩種開法完全相同；差別只在「啟動限定」那幾項。

### A. `skillpool <profile>` 啟動
- 建立 `sessions/<id>` 連結，`--add-dir` 加入；子行程環境變數帶 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`。
- `--settings <run file>`：`enabledPlugins`（plugins.off / on）、`autoMemoryDirectory`（`profiles/<name>/memory/<project-key>/`）、`skillOverrides`（只用於 `skills.off`）。
- `mcp.only` 時 `--strict-mcp-config --mcp-config`，帶入**已核准**的專案 server（第 9 節）。
- `--model` / `--effort` / `--name` / `--session-id`，環境變數 `AGENT_PROFILE`。

中途再切換：改連結 + 壓縮。run file 能否中途改寫生效待驗；若可以，plugin 開關、記憶位置也能一起換。

### B. 一般 `claude` 開的 session
`/skillpool <profile>`：
1. 建立或改指 `sessions/<id>`（以 `$.session.id()` 命名）。
2. 第一次：mod 執行 `/add-dir sessions/<id>`，畫面跳確認框，使用者按一次 Enter（選「只限這個 session」）。之後切換不再問。若使用者選了「remember」，資料夾會寫進專案設定、破壞隔離；mod 用 `$.settings.read()` 檢查並警告。
3. mod 呼叫 `$.session.compact()` 壓縮一次（`{ skip }` 視為正常）。

`/skillpool off`：把連結指向一個空的 profile（或移除連結）並壓縮。

啟動限定的項目在一般 session（mod 只能讀設定，不能寫）：
- plugin 關閉 / MCP 範圍：擋呼叫、不提供 plugin 的 agent 類型、縮短 MCP 工具說明；plugin 的 skill 仍在清單上。
- 原生記憶位置：換不了。CLAUDE.md 的記憶索引會指出本專案的記憶檔，模型照索引讀寫；原生記憶的說明仍在，可能混用。
- model / effort：不自動換。

不設 `claude` 別名：一般 session 用 `/skillpool <name>` 就能切換 profile 的 CLAUDE.md 與 skill；需要啟動限定的項目（真的關 plugin、MCP 範圍、model、記憶位置）時，才改用 `skillpool <name>` 啟動。

herdr-commander 不改；它開的 worker 是一般 session，worker 用哪個 profile 目前無法指定。

## 7. skill 池與 plugin

- 池子：`~/.claude/skillpool/pool/<skill>/`。
- 指令：
  - `skillpool pool list`：池子內容、各 skill 被哪些 profile 使用。
  - `skillpool pool add <skill>`：把 `~/.claude/skills/<skill>` 搬進池子（先備份；列出影響、需使用者同意）。
  - `skillpool pool remove <skill>`：搬回全域。
- profile 透過 `skills.use` 在自己的 `.claude/skills/` 建 junction；只給一個 profile 用的 skill 也可以直接放在該 profile 資料夾裡。
- plugin：不搬進池子，用 `plugins.off` / `plugins.on` 整個開關。啟動時真的不載入（只影響這個 session）；中途切換只能擋呼叫。`claude plugin disable` 會影響所有 session，不採用。
- `/skillpool:doctor` 建議哪些 skill 留全域、哪些搬進池子、分給哪些 profile。
- 搬走的 skill 在沒用 profile 的地方（`claude -p` 腳本、herdr worker、其他工具）看不到；這是預期行為（沒有預設 profile），每個 session 都要用的 skill 就留在全域。

## 8. 記憶

- 跨專案記憶：profile CLAUDE.md 的「## 跨專案記憶」，模型直接更新。
- 專案記憶：`profiles/<name>/memory/<project-key>/`。啟動時用 `autoMemoryDirectory` 讓 Claude Code 原生記憶寫到這裡（資料夾不存在會自動建立，已實測）。
- 記憶索引：CLAUDE.md 標記區塊，每個專案一行（project-key、`MEMORY.md` 路徑、最後使用日期）。啟動、切換時更新。
- 一般 session 中途切換：原生記憶位置不變，模型依索引讀寫該專案的記憶檔。

## 9. MCP

- `mcp.only` / `mcp.off` 沿用。
- `mcp.project`：`true`（預設）/ `false`。`mcp.only` 模式下只帶入使用者**已核准**的專案 server（`enabledMcpjsonServers`、`enableAllProjectMcpServers` 或 `~/.claude.json` 的專案紀錄），避免陌生 repo 的 server 被自動執行；`false` 時 strict 模式不帶入、非 strict 模式用 `disabledMcpjsonServers`。
- 中途切換：只能擋呼叫並縮短工具說明。

## 10. subagent

- `skillpool <p> -p` / `--bg`：完整隔離（同現在）。
- 產生的 `skillpool-<name>` subagent：全域與專案 CLAUDE.md 照常載入；內文要求先讀 `profiles/<name>/CLAUDE.md`，並列出它的 skill 路徑（能否直接看到主 session 加入的 skill 待驗）；記憶照索引讀寫（實測可行）。不用 `memory: local`（會寫進專案 `.claude/agent-memory-local/`，git 不會忽略）。
- mod 依 subagent 類型套用該 profile 的擋呼叫規則（同 v0.3）。

## 11. 驗證狀態

| 項目 | 狀態 |
|---|---|
| 啟動參數換記憶位置、關 skill、帶專案 MCP、排除 CLAUDE.md（進階選項） | ✅ 2.1.300 |
| `--settings` skill 開關蓋過專案 `settings.local.json` | ✅ 2.1.300 |
| 組織 plugin 仍跳過 `prompt.context` / `prompt.compose`；`tool.call` 擋呼叫、`prompt.submit` 附加內容有效 | ✅ 2.1.300 |
| 中途 `/add-dir` 載入 CLAUDE.md；壓縮與 `/clear` 後重讀新內容 | ✅ 2.1.304 |
| 環境變數必要；寫在設定檔 `env` 有效 | ✅ 2.1.304 |
| mod 用 `$.clock.after` 觸發 `/add-dir` + `$.session.compact()`（確認框按一次 Enter） | ✅ 2.1.304 |
| 加入資料夾的 skill 即時載入、新增即時可用、刪除即時擋、`/clear` 後清單更新、junction 可用 | ✅ 2.1.304 |
| 連結改指向 + 壓縮 = 完整切換（CLAUDE.md、skill 清單、呼叫）；刪除的 skill 壓縮後從清單消失；`rmdir` 只刪連結 | ✅ 2.1.304 |
| 啟動時用 `--add-dir` 不跳確認框 | ✅ 2.1.304 |
| `-r` 恢復 session 後中途加入的資料夾不會帶回（mod 在 session 開始時重新加入，會再問一次） | ✅ 2.1.304 |
| `--settings` run file 中途改寫是否生效（plugin 開關、記憶位置） | ⏳ |
| subagent 看得到加入資料夾的 skill；捷徑套捷徑（session → profile → 池子）也能載入 | ✅ 2.1.304 |
| 環境變數開啟後，其他 add-dir 資料夾的 CLAUDE.md 也會載入（副作用確認） | ⏳ |
| `$.session.compact()` 在幾乎空的對話回 `{ skip }` 時的行為 | ⏳ |
| 連結由 Python 啟動器建立／改指／移除（mod 透過 `$.process.run` 呼叫）；mod 的 `$.fs` 沒有刪除功能 | ✅ |
| mod 依 Edit 位置擋 CLAUDE.md 規則區修改，記憶區可寫；`/skillpool off`（連結改指向空資料夾 + 壓縮） | ✅ 2.1.304 |

| session 結束時刪連結：Claude Code 給整條結束流程約一秒，其他 plugin 先用掉時刪不到 → 改成 mod 每 10 分鐘寫心跳檔，停止超過兩小時的連結由下一次 `skillpool` 指令清掉 | ✅ 2.1.304 |
| 使用者設定 `autoMemoryEnabled: false` 時原生記憶不運作，profile 記憶只靠 CLAUDE.md 索引（`show` 會提醒） | ✅ 2.1.304 |

## 12. 實作順序

1. **profile 資料夾 + 連結**：新目錄結構、`skillpool new`、`sessions/<id>` 連結建立 / 改指 / 安全刪除、啟動器改用 `--add-dir`。
2. **skill 池**：`pool` 指令、`skills.use` 建 junction、規則引用的池子 skill 自動加入。
3. **mod 中途切換**：一般 session 的 add-dir + 壓縮、`skillpool` 開的 session 的切換、`/skillpool off`、連結清理。
4. **記憶**：`autoMemoryDirectory`、記憶索引區塊、寫入規則（mod 擋規則區）。
5. **MCP**：`mcp.project`、只帶已核准的專案 server。
6. **subagent**：產生器更新。
7. **doctor、README、`/skillpool:profile`、測試**（Python 與 TS 共用規則引用偵測的測試資料）；v0.3 的 `profiles/<name>.json` 轉成資料夾、拿掉專案層 profile（目前沒有正式 profile，只需處理測試資料）。

剩下的 ⏳ 項目不影響目前的功能，之後再補測。

## 13. 待決定

（無，全部已決定。）
