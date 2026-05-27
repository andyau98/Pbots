# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 開發鐵律（所有新增功能必須遵循）

### 規則 0：全部使用中文溝通

與用戶嘅所有溝通（包括回覆、thinking、程式註解、訊息字串）**必須**使用繁體中文。唔好用英文。

### 規則 1：互動命令必須使用 SessionManager

任何需要多步驟問答的工具（向用戶提問、收集資料、等待回覆），**必須**透過 `SessionManager` 實現，不得自行管理會話狀態。

- **群組觸發** → 中間問答經私訊進行 → 最終結果發回群組
- **私訊觸發** → 所有問答及結果在私訊中完成

Handler 標準介面：

```js
{
    name: '工具名稱',
    async start(ctx, meta) → { question: "..." } | { done: true, result: "..." },
    async handleReply(ctx, message) → { question: "..." } | { done: true, result: "..." },
    async onTimeout(ctx) → "超時訊息",
    async onCancel(ctx) → "取消訊息",
}
```

**Handler 回傳值完整 Schema：**

```
start(ctx, meta) 回傳：
  { done: true, result: "..." }               ← 一步完成，直接發送
  { question: "..." }                          ← 需要用戶輸入，發送到私訊

handleReply(ctx, message) 回傳：
  { done: true, result: "..." }               ← 完成，發送文字結果到原始來源
  { done: true, result,                        ← 完成 + 單一附件
    attachment: "/path/to/file" }
  { done: true, result,                        ← 完成 + 多附件
    attachments: ["/path/1.pdf", "/path/2.pdf"],
    attachmentCaption: "摘要文字",
    completionMessage: "✅ 已完成所有發送" }
  { question: "..." }                          ← 繼續問下一條問題（發到私訊）

onTimeout(ctx) → "string | void"              ← 超時時發送嘅訊息
onCancel(ctx)  → "string | void"              ← 取消時發送嘅訊息
```

啟動方式：`sessionManager.start(userId, originId, handler, context, client, timeout, senderId)`

- `senderId`：發送者嘅完整 WhatsApp ID（含 `@c.us` 或 `@lid` 後綴），用於正確格式嘅私訊發送
- `sessionManager.start()` 回傳 `{ success, isGroup, message, handled }` — 若 `isGroup && message` 需要在群組中提示用戶檢查私訊
- `senderId` 若省略則由 SessionManager 自動推斷（見下方 WhatsApp 細節）

### 規則 2：所有可變數據必須透過 DataStore

**禁止**直接讀寫 JSON 檔案。所有持久化數據操作必須經過 `src/core/dataStore.js`：

```
configs/settings.json  →  靜態設定（前綴、功能開關、路徑）
.env                   →  敏感資訊（密碼）
data/store/*.json      →  可變數據（管理員、封鎖、群組…）
data/exports/          →  統一輸出路徑（報表、備份、PDF）
```

```js
const { dataStore } = require('./core/dataStore');

// 管理員
dataStore.getAdmins() / dataStore.addAdmin(id) / dataStore.removeAdmin(id);

// 封鎖
dataStore.getBlockedUsers() /
    dataStore.blockUser(id, reason) /
    dataStore.unblockUser(id);

// 通用擴展（新增數據類型不用改 DataStore）
dataStore.set('key', value);
dataStore.get('key', defaultValue);

// 統一輸出
dataStore.exportFile('filename', content);
```

**例外注意：** `foremen.json` 目前透過 `dataStore._read('foremen.json')` / `dataStore._write('foremen.json')` 內部方法操作（`workerAttendance.js` 和 `scheduler.js`），而非公共 API。新功能應優先使用泛型 `get(key)` / `set(key, value)`。

### 規則 3：命令必須透過 CommandRouter 登記

所有命令在 `src/modules/commands.js` 的 `registerAll()` 中登記：

```js
router.register('命令名', handler, {
    requireAuth: true, // 是否需要管理員權限
    aliases: ['別名'], // 可選別名
    isHash: false, // 是否為 # 開頭的 hash 命令
});
```

Handler 簽名：`async (message, context, client, services) => void`

**Context 物件結構（由 index.js 建構）：**
```js
{
    userId: '85298765432',       // 純數字電話號碼
    originId: '123@g.us',        // 訊息來源完整 ID（群組或私訊）
    whatsappId: '85298765432@c.us', // 完整 WhatsApp ID（含 @c.us 或 @lid）
    isGroup: true,               // 係咪群組訊息
    pushname: '阿強',            // WhatsApp 顯示名稱
    messageBody: '#申報',        // 原始訊息文字
    message: <Message>,          // whatsapp-web.js Message 物件
    groupName: '工地群組',       // 群組名稱（私訊為 null）
    groupId: '123@g.us',        // 群組 ID（私訊為 null）
}
```

### 規則 4：訊息路由優先級（不可變更）

```
1. 群組鎖定檢查（Phase 7）
2. SessionManager 活躍會話攔截
3. 媒體自動下載
4. 命令路由 (CommandRouter)
```

### 規則 5：重啟時保留 WhatsApp Session

**不可** `rm -rf .wwebjs_auth/`。只殺 Node 進程，保留已登入的 session：

```bash
# ✅ 正確：優雅重啟（Windows）
taskkill //F //IM node.exe
taskkill //F //IM chrome.exe
# 只移除鎖定檔（不刪 session）：
rm -f .wwebjs_auth/session-pbots-client/SingletonLock
rm -f .wwebjs_auth/session-pbots-client/Default/SingletonLock
npm start

# 或使用 PBOTS.bat 一鍵重啟
```

---

## 指令

```bash
npm start              # 啟動機器人 (node src/index.js)
node src/index.js      # 直接啟動（同 npm start）
PBOTS.bat              # Windows 一鍵重啟（kill 舊進程 → 清鎖定檔 → 啟動）
npm run lint           # ESLint 檢查（flat config：eslint.config.js，v10）
npm run lint:fix       # ESLint 自動修復
npm run format         # Prettier 格式化（.prettierrc.json：semi, singleQuote, tabWidth 4）
npm run format:check   # Prettier 檢查
npm test               # 執行測試 (node --test)
```

## 新電腦設定

```bash
git clone https://github.com/andyau98/Pbots.git
cd Pbots
git checkout master
npm install
cp .env.example .env
# 編輯 .env，設定 AUTH_PASSWORD=你的密碼
# 從舊電腦複製 .wwebjs_auth/ 目錄以保留 WhatsApp 登入（可選）
npm start
```

### Claude Code 跨電腦工作

此 repo 已包含 CLAUDE.md 和 `skills-lock.json`，Claude Code 會自動讀取：

- **CLAUDE.md** — 專案指引，在任何電腦上 Claude Code 都會自動載入
- **skills-lock.json** — 鎖定已安裝的 skills（integrate-whatsapp、pdf-generator），換電腦後 Claude Code 會自動還原
- **`.claude/` 目錄** — 已在 `.gitignore` 中排除。每台電腦需獨立設定（permissions、hooks 等），不需同步

### 換電腦後需手動調整

```bash
# 1. 修改 POR 圖紙路徑（每台電腦路徑不同）
# 編輯 configs/settings.json → paths.por

# 2. 若使用不同作業系統，檢查 Chrome 路徑
# Windows 預設：C:/Program Files/Google/Chrome/Application/chrome.exe
# macOS 需改為：/Applications/Google Chrome.app/Contents/MacOS/Google Chrome

# 3. 若沒有舊 WhatsApp session，掃 QR Code 重新登入即可
```

## 架構總覽

PBOTS 是基於 `whatsapp-web.js` + `LocalAuth` 的 WhatsApp 機器人，用於幕牆工地管理。

### 目錄結構

```
src/
├── index.js                  # 主入口：初始化、訊息接收、生命週期管理
├── core/
│   ├── authManager.js        # 統一權限管理（→ DataStore）
│   ├── commandRouter.js      # 命令路由器：登記→解析→權限→分發
│   ├── sessionManager.js     # 通用互動會話管理器（群組/私訊分流 + 群組鎖定）
│   ├── dataStore.js          # JSON 統一資料層（admins/blocked/groups/foremen 等）
│   ├── database.js           # SQLite 資料庫（better-sqlite3），取代 JSON 儲存圖紙索引
│   ├── monitorServer.js      # HTTP 監控儀表板（localhost:3456，6卡 + SSE 日誌串流）
│   ├── logStream.js          # SSE 即時日誌串流（攔截 console.log/warn/error）
│   └── scheduler.js          # node-cron 排程（9:00 AM 考勤 + 12:00 PM 圖紙索引重建）
├── modules/
│   └── commands.js           # 所有命令的登記與處理函數
skills/
├── workerAttendance.js       # 工人考勤模組（判頭登記、申報人數、配合排程自動通知）
├── drawingSearch.js          # 物料圖紙搜尋（SQLite 索引 + 模糊匹配 + DWG 位置圖）
├── tgParser.js               # TG 位置圖內容提取（DXF 純文字 > PDF 文字 > OCR，三層策略）
└── README.md                 # 技能規劃
tools/
├── common/utils.js           # 共用工具函數
├── messageLogger.js          # JSONL 訊息日誌
├── mediaDownloader.js        # 自動下載媒體
├── imageToPdf.js             # 照片→PDF（pdfkit, simhei.ttf）
├── cleanup.js                # 舊檔案清理
├── healthMonitor.js          # 系統健康監控
├── errorRecovery.js          # 錯誤恢復（指數退避）
├── weatherReporter.js        # 香港天文台天氣（axios）
├── newsReporter.js           # 地盤意外新聞（cheerio）
├── realNewsFetcher.js        # Google News RSS
└── dwgReader.js              # DWG 文字提取（libredwg dwgread，不需 OCR）
configs/
└── settings.json             # 靜態配置
data/
├── store/                    # admins.json, blocked.json, groups.json, foremen.json, pbots.db
├── exports/                  # 統一輸出路徑
├── chats/                    # 訊息日誌 (JSONL)
├── images/                   # 媒體圖片
└── pdfs/                     # PDF 文件
Sample/LabourSummary/
└── HGRH開工人數表.xlsx        # 考勤 Excel 範本
tools/libredwg/               # libredwg 二進位（Windows: dwgread.exe + DLL）
python/                       # Python 圖紙工具（extractor.py, searcher.py），獨立 SQLite DB
```

### 共用工具函數 (tools/common/utils.js)

`tools/common/utils.js` 提供三個被多個模組依賴的基本函數：

- `ensureDir(dirPath)` — 確保目錄存在，不存在則遞迴建立
- `formatFileSize(bytes)` — 格式化檔案大小為可讀字串（B/KB/MB/GB）
- `calculateDirSize(dirPath)` — 遞迴計算目錄下所有檔案的總大小

### 服務容器 (Services Container)

`index.js` 初始化所有模組後，將其注入單一 `services` 物件，傳遞給每個命令處理器。可用的服務鍵名：

```
config, authManager, sessionManager, dataStore, monitorServer,
messageLogger, mediaDownloader, imageToPdf, cleanupManager,
healthMonitor, errorRecovery, weatherReporter, newsReporter
```

新增模組的 handler 可以透過解構取得所需服務：`async (msg, ctx, client, { serviceName }) => {}`

### LogStream 日誌攔截機制

`src/core/logStream.js` 係一個 `EventEmitter` 單例，喺 `index.js` 最開頭（`require('dotenv').config()` 之後即時）攔截 `console.log` / `console.warn` / `console.error`：

- 所有 console 輸出被封裝為 `{ time, level, text }` 格式
- 緩存最近 200 條日誌喺記憶體
- 透過 `emit('line', ...)` 推送俾 MonitorServer 嘅 SSE 客戶端
- **任何 `console.log` 都自動變成日誌串流嘅一部份**，包括第三方套件嘅輸出

### SQLite 資料庫 (database.js)

`src/core/database.js` 使用 `better-sqlite3`，目前由 `drawingSearch.js` 使用，逐步取代 JSON 檔案儲存圖紙相關數據。僅透過 `getDatabase()` singleton 存取：

```
pbots.db
├── files                # 圖紙索引（取代 drawing_index.json）
│   ├── name, path, ext, folder
│   ├── system, systems  # 系統碼（如 FST、FAC）
│   ├── por              # POR 子目錄名
│   └── materials, has_tag
├── folder_cache         # Folder 級預緩存（加快位置圖搜尋速度）
│   └── drawing_numbers, drawing_files, tg_files, dwg_tg_files, pdf_tg_files
└── tg_cache             # TG DWG 內容快取（取代 app.json tg_content_cache）
    └── drawing_numbers, source_method, mtime
```

**注意：** `dataStore` (JSON) 同 `database` (SQLite) 係並存嘅兩個儲存系統。JSON 仍然負責：管理員、封鎖、群組、判頭等數據。SQLite 只負責圖紙索引相關。新功能若需要結構化查詢（WHERE、ORDER BY）應考慮 SQLite；若只係 key-value 應優先使用 DataStore。

### 監控儀表板 API

MonitorServer（`src/core/monitorServer.js`）提供三個 HTTP endpoint：

| Endpoint | 說明 |
|----------|------|
| `GET /` | HTML 頁面（QR Code 掃碼頁 或 儀表板，自動切換） |
| `GET /api/status` | JSON 狀態 API（訊息統計、安全、健康、系統資源、活躍會話） |
| `GET /api/logs/stream` | SSE 即時日誌串流（歷史 50 條 + 即時推送） |

儀表板前端功能：日誌級別過濾（Info/Warn/Error）、關鍵字搜尋、暫停自動捲動、清除緩存（最多保留 300 行）。

### 排程任務

| 時間    | 頻率     | 任務                                     |
| ------- | -------- | ---------------------------------------- |
| 9:00 AM | 週一至六 | 考勤申報（向已登記判頭發送私訊收集人數） |
| 12:00 PM | 每日     | 重建圖紙索引（掃描 `paths.por` 目錄）    |

時區固定為 `Asia/Hong_Kong`。

### 圖紙搜尋 (Drawing Search)

`skills/drawingSearch.js` 使用**SQLite 預建索引策略**：啟動時掃描 `config.paths.por` 目錄，將索引存入 `pbots.db` 嘅 `files` 表，後續查詢只讀 SQLite 不掃描檔案系統。索引支援物料碼前綴分類（FST=鐵料、FAC=鋁板、BGL=玻璃、ACD=鋁板、HGRH=鋁型材 等 16 類），並提供**空格分隔多條件 AND 搜尋**（物料碼 + 通用碼 + 關鍵字可混搭）。支援「格式選擇」步驟：可揀 PDF、DWG、或兩者一併下載。中午 12:00 自動重建，管理員可手動 `#searchpor`。

**多步驟互動狀態機（#Drawing）：**

```
input ──→ [結果>20?] ──→ filter_material ──→ [系統碼>1?] ──→ filter_system
  │                                                                    │
  └───→ [≤20 或跳過篩選] ←──────────────────────────────────────────────┘
                          │
                          ↓
                    format_select (PDF/DWG/兩方)
                          │
                          ↓
                     ask_dwg (有同名 DWG? y/n)
                          │
                          ↓
              ┌─── scanAndShowTg (DWG 直接提取文字)
              │         │
              │    select_tg (數字選擇，逗號分隔多選)
              │      │       │
              │    show_detail (v 鍵查看逐頁繪圖編號)
              │      │
              └──→ send (完成發送)
```

每個步驟支援 `#R` 返回上一層，`#cancel` 取消。位置圖內容提取使用**DWG-only 策略**（libredwg 直接提取，不需 OCR）—— `tgParser.js` 保留 PDF/OCR fallback 但主要路徑已改為 DWG。

### TG 位置圖引擎 (tgParser.js)

`skills/tgParser.js` 為 `drawingSearch.js` 嘅輔助模組，負責從 TG（位置圖）檔案提取繪圖編號，建立 Folder-Level 雙向索引：

- **優先順序**：DXF (純文字) > PDF 文字 (pdfjs-dist) > PDF OCR (MuPDF + Tesseract) > DWG (唔支援)
- **兩階段掃描**：階段1 掃描所有 Folder 建立全域檔案索引 → 階段2 提取 TG 內容並 cross-reference 對應加工圖檔案
- **OCR 快取**：以 `dataStore` 嘅 `tg_content_cache_v2` 快取 OCR 結果，避免重複識別
- **繪圖編號正則**：`[A-Z]{2,4}[-_]?(?:[A-Z])?\d{3,6}`

### DWG Reader (dwgReader.js)

`tools/dwgReader.js` 使用 libredwg 的 `dwgread` 工具直接從 AutoCAD DWG 檔案提取文字，**不需 OCR，100% 準確**。提取結果包含 MTEXT（多行文字）和 ATTRIB（屬性文字）。

- **依賴外部二進位：** `tools/libredwg/dwgread.exe`（Windows，附在 repo）或系統安裝版（macOS/Linux）
- **跨平台路徑：** Windows 用 `tools/libredwg/`，macOS 用 `/tmp/libredwg-0.13.4/` 或 `/usr/local/bin/`，Linux 用 `/usr/local/bin/` 或 `/usr/bin/`
- **Windows DLL 依賴：** 執行時需要將 dwgread.exe 所在目錄加入 PATH，否則會找不到 DLL
- **輸出格式：** dwgread 輸出 minJSON，經 `parseDwgJson()` 解析並用 `fixDwgJson()` 修正 nan 等非法值
- **主要 API：** `extractTextFromDwg(path)` → `[{text, entity}]`, `extractTextArrayFromDwg(path)` → `string[]`, `isDwgReaderAvailable()` → `boolean`
- **Timeout：** 預設 120 秒（大型 DWG 檔案需要較長時間處理）

### Python 圖紙工具 (python/)

`python/` 目錄包含一組 Python 實作的圖紙輔助搜尋工具（獨立於主 Node.js 程式的實驗性元件）：

- `extractor.py` — PDF/DWG 圖紙文字提取器
- `searcher.py` — 基於圖紙編號的搜尋引擎
- `requirements.txt` — Python 依賴（`PyMuPDF`, `ezdxf`, `opencv-python` 等）
- `test_f9551.db` — 獨立 SQLite 測試資料庫

**注意：** 此目錄非機器人主流程之一部份，屬獨立實驗性質。執行需 Python 3.9+ 及獨立 `pip install -r requirements.txt`。

### 考勤模組 (Worker Attendance)

`skills/workerAttendance.js` 管理判頭登記與每日工人人數申報。核心流程：

- **登記判頭** (`#登記判頭`)：互動式選擇 Excel 欄位（公司名），自動綁定 WhatsApp ID
- **申報人數** (`#申報`)：判頭輸入人數 → 確認 → 寫入 Excel。**若今日已申報，會顯示原有數字並支援修改**
- **自動申報**：每日 9:00 AM（週一至六）向所有已登記判頭發送私訊請求
- **查詢** (`#今日人數`)：顯示今日各公司已申報人數及總數
- Excel 操作使用 `exceljs` 保留原有格式、樣式、合併儲存格

### AuthManager 雙 Session 系統

注意：目前存在**兩套並存**的會話管理系統：

1. **SessionManager（主要，新）** — `src/core/sessionManager.js`，用於所有多步驟命令（圖紙搜尋、PDF收集、考勤申報）。支援群組鎖定（Phase 7）、超時、群組/私訊分流。
2. **AuthManager 內建 Session（舊，僅 whitelist）** — `src/core/authManager.js` 內的 `hasActiveSession()` / `startPrivateSession()` / `handlePrivateReply()`。這是在 SessionManager 出現前為 `!whitelist` 認證流程而設的。所有新功能**必須**使用 SessionManager。

### 根目錄暫存檔

以下檔案是除錯/測試產物，不應提交到 git：

- `_tmp_debug_cpb.js`, `_tmp_ls.js`, `_tmp_search_cpb.js`, `_tmp_xlsx.js` — 測試用 script
- `nul'` — Windows 重導向產生的異常檔案
- `eng.traineddata` — Tesseract OCR 語言資料（5MB），非專案程式碼

### 錯誤恢復

`tools/errorRecovery.js` 實現指數退避重連：基數 1 秒、上限 30 秒、最多 10 次。錯誤分類為：認證、連接、網絡、權限、檔案、媒體、記憶體、未知。心跳監控每 60 秒更新一次。

### WhatsApp 特定細節

- **用戶 ID 格式：** `<電話號碼>@c.us`（私人）或 `<id>@g.us`（群組）或 `<id>@lid`（LID 格式）
- **SessionManager senderId 推斷邏輯**（`_sendDM()` 方法）：
  1. 優先使用 `session.senderId`（如果含 `@`）
  2. 否則如果 `userId` 已含 `@` 就直接用
  3. 否則根據 `originId` 嘅後綴推斷：`@lid` → `userId@lid`，否則 `userId@c.us`
  - 呢個係支援 WhatsApp LID 格式嘅關鍵，所有 `sessionManager.start()` 應傳入 `context.whatsappId` 作為 senderId
- `message.fromMe` 過濾自己的訊息
- `message.downloadMedia()` → `{ data: base64, mimetype }`
- 系統 Chrome 路徑（Windows）：`C:/Program Files/Google/Chrome/Application/chrome.exe`（見 `src/index.js` puppeteer 設定）
- 中文字體（Windows）：`C:/Windows/Fonts/simhei.ttf`（pdfkit 用）

### 關鍵配置路徑

| 設定項 | 位置 | 說明 |
|--------|------|------|
| `AUTH_PASSWORD` | `.env` 檔案 | **唯一活躍嘅認證密碼來源**。`settings.json` 嘅 `security.auth_password` 只係 fallback |
| `paths.por` | `settings.json` | 物料圖紙目錄，`#圖紙` 命令的強依賴 |
| `features.reply_in_group` | `settings.json` | 控制群組中非 whitelist 命令是否回覆 |
| `security.whitelist_enabled` | `settings.json` | 白名單模式開關 |
| `security.auth_password` | `settings.json` | **已棄用**，僅當 `.env` 無 `AUTH_PASSWORD` 時做 fallback |

### 完整命令列表

| 命令                                                                                         | 類別 | 權限 | 功能                                             |
| -------------------------------------------------------------------------------------------- | ---- | ---- | ------------------------------------------------ |
| `!ping`                                                                                      | 基礎 | 公開 | 測試響應                                         |
| `!help`                                                                                      | 基礎 | 公開 | 幫助訊息                                         |
| `!status`                                                                                    | 基礎 | 公開 | 機器人狀態                                       |
| `!stats`                                                                                     | 基礎 | 公開 | 今日統計                                         |
| `!weather` / `!天氣`                                                                         | 資訊 | 公開 | 香港天氣                                         |
| `!news` / `!新聞` / `!地盤` / `!construction` / `!monitor` / `!監控` / `!accident` / `!意外` | 資訊 | 公開 | 地盤新聞                                         |
| `!whitelist <密碼>`                                                                          | 認證 | 公開 | 內聯認證                                         |
| `!whitelist`                                                                                 | 認證 | 公開 | DM 認證流程                                      |
| `#TOPDF [標題]`                                                                              | PDF  | 管理 | 照片收集→PDF                                     |
| `#done`                                                                                      | PDF  | 管理 | 完成 PDF                                         |
| `#cancel`                                                                                    | 通用 | 管理 | 取消當前會話                                     |
| `#申報`                                                                                      | 考勤 | 管理 | 申報今日人數（支援修改：重複觸發會顯示原有數字） |
| `#今日人數`                                                                                  | 考勤 | 管理 | 查詢今日申報                                     |
| `#登記判頭`                                                                                  | 考勤 | 管理 | 互動登記判頭                                     |
| `#判頭列表`                                                                                  | 考勤 | 管理 | 列出判頭                                         |
| `#移除判頭 [ID]`                                                                             | 考勤 | 管理 | 移除判頭                                         |
| `!security`                                                                                  | 管理 | 管理 | 安全狀態                                         |
| `!cleanup`                                                                                   | 管理 | 管理 | 系統清理                                         |
| `!mediastats`                                                                                | 管理 | 管理 | 媒體統計                                         |
| `!addgroup`                                                                                  | 管理 | 管理 | 授權群組                                         |
| `!removegroup [ID]`                                                                          | 管理 | 管理 | 移除授權                                         |
| `!cleanupwhitelist`                                                                          | 管理 | 管理 | 重置所有白名單數據                               |
| `#圖紙 [編號]`                                                                               | 圖紙 | 管理 | 搜尋圖紙 (POR)                                   |
| `#searchpor`                                                                                 | 圖紙 | 管理 | 手動重建圖紙索引                                 |
| `#dwgfind` / `#找位置圖` / `#findlayout`                                                    | 圖紙 | 管理 | 輸入加工圖號 → 反向查詢對應 TG 位置圖             |
