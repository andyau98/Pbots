# PBOTS 幕牆工地 WhatsApp 機器人 — 完整項目總覽

> 最後更新：2026-06-12
> GitHub：https://github.com/andyau98/Pbots
> 開發環境：Windows 10 Pro + Node.js v20.18.0

---

## 目錄

1. [專案背景](#1-專案背景)
2. [架構總覽](#2-架構總覽)
3. [開發鐵律](#3-開發鐵律)
4. [完整命令列表](#4-完整命令列表)
5. [已實作模組](#5-已實作模組)
6. [技術棧](#6-技術棧)
7. [新電腦設定](#7-新電腦設定)
8. [監控儀表板](#8-監控儀表板)
9. [DeepScan TG 位置圖系統](#9-deepscan-tg-位置圖系統)
10. [待開發模組](#10-待開發模組)

---

## 1. 專案背景

PBOTS 是基於 `whatsapp-web.js` + `LocalAuth` 的 WhatsApp 機器人，專門用於**幕牆（Curtain Wall）工地管理**。

### 核心場景

- **工人考勤**：每日 9:00 AM 自動向判頭收集工人人數，填入 HGRH Excel 表
- **照片收集→PDF**：工地巡查拍照，收集後自動生成 A4 PDF 報告
- **物料圖紙搜尋**：52,000+ 加工圖 PDF/DWG 的快速搜尋 + 位置圖對應
- **權限管理**：白名單 + 群組授權，管理員控制工具存取
- **資訊查詢**：香港天氣、地盤意外新聞

### 用戶角色

- **管理員**：擁有全部命令權限，可登記判頭、授權群組
- **判頭（Foreman）**：每日申報工人人數，一家公司一位
- **管工（Supervisor）**：日常巡查使用 PDF 收集、圖紙搜尋等功能

---

## 2. 架構總覽

### 目錄結構

```
PBots/
├── src/
│   ├── index.js                  # 主入口：初始化、訊息路由、生命週期
│   ├── core/
│   │   ├── authManager.js        # 統一權限管理（→ DataStore）
│   │   ├── commandRouter.js      # 命令路由器：登記→解析→權限→分發
│   │   ├── sessionManager.js     # 互動會話（群組/私訊分流 + 群組鎖定）
│   │   ├── dataStore.js          # 統一 JSON 資料層
│   │   ├── database.js           # SQLite 資料庫（圖紙索引、TG 快取）
│   │   ├── monitorServer.js      # HTTP 儀表板 localhost:3456 + SSE 日誌
│   │   ├── logStream.js          # 攔截 console → SSE 推送
│   │   └── scheduler.js          # node-cron 排程
│   └── modules/
│       └── commands.js           # 所有命令的登記與處理函數
│
├── skills/
│   ├── workerAttendance.js       # 🕐 工人考勤模組
│   ├── drawingSearch.js          # 📦 物料圖紙搜尋（SQLite + DeepScan）
│   ├── tgParser.js               # 📐 TG 位置圖內容提取（三層策略）
│   └── README.md                 # 技能規劃文件
│
├── tools/
│   ├── common/utils.js           # 共用工具函數
│   ├── messageLogger.js          # JSONL 訊息日誌
│   ├── mediaDownloader.js        # 自動下載媒體
│   ├── imageToPdf.js             # 照片→PDF（pdfkit + simhei.ttf）
│   ├── dwgReader.js              # DWG 文字提取（libredwg dwgread）
│   ├── cleanup.js                # 舊檔案清理
│   ├── healthMonitor.js          # 系統健康監控
│   ├── errorRecovery.js          # 錯誤恢復（指數退避）
│   ├── weatherReporter.js        # 香港天氣（axios + 天文台 API）
│   ├── newsReporter.js           # 地盤新聞（cheerio）
│   └── realNewsFetcher.js        # Google News RSS 解析
│
├── configs/
│   └── settings.json             # 靜態配置（前綴、路徑、功能開關）
│
├── data/
│   ├── store/                    # 可變數據 + pbots.db
│   │   ├── admins.json           # 管理員列表
│   │   ├── blocked.json          # 封鎖用戶
│   │   ├── groups.json           # 授權群組
│   │   └── foremen.json          # 判頭配置
│   ├── exports/                  # 統一輸出路徑
│   ├── chats/                    # 訊息日誌 (JSONL)
│   ├── images/                   # 媒體圖片
│   └── pdfs/                     # PDF 文件
│
├── Sample/LabourSummary/
│   └── HGRH開工人數表.xlsx        # 考勤 Excel 範本
│
├── tools/libredwg/               # libredwg 二進位（Windows: dwgread.exe）
├── python/                       # Python 圖紙工具（實驗性）
├── CLAUDE.md                     # Claude Code 開發指引
├── .env.example                  # 環境變數範例
└── package.json
```

### 訊息路由優先級

```
1. 群組鎖定檢查（Phase 7）     ← 防止他人干擾進行中的會話
2. SessionManager 活躍會話攔截  ← 多步驟問答路由
3. 媒體自動下載                 ← 保存圖片/文件
4. 命令路由 (CommandRouter)     ← 單步命令處理
```

### 互動會話規則（SessionManager）

```
用戶觸發命令
    ├─ 群組 (@g.us)
    │     ├─ 所有中間問答 → 私訊給用戶
    │     ├─ 每步確認「✅ 收到: {答案}」
    │     ├─ 群組鎖定（其他人無法干擾）
    │     └─ 最終結果 → 發回群組
    │
    └─ 私訊 (@c.us / @lid)
          └─ 全部問答及結果 → 在私訊中完成
```

### 數據職責分離

```
configs/settings.json     →  靜態設定（前綴、路徑、功能開關）
.env                      →  敏感資訊（密碼 AUTH_PASSWORD）
data/store/*.json         →  可變數據（管理員、封鎖、群組、判頭…）
data/store/pbots.db       →  SQLite（圖紙索引、TG 快取、TG 映射）
data/exports/             →  輸出的報表、備份、PDF
```

---

## 3. 開發鐵律

### 規則 1：互動命令必須使用 SessionManager

任何需要多步驟問答的工具，**必須**透過 `sessionManager.start()` 實現。

Handler 標準介面：

```js
{
    name: '工具名稱',
    async start(ctx) → { question: "..." } | { done: true, result: "..." },
    async handleReply(ctx, message) → { question: "..." } | { done: true, result: "..." },
    async onTimeout(ctx) → "超時訊息",
    async onCancel(ctx) → "取消訊息",
}
```

### 規則 2：所有可變數據必須透過 DataStore 或 Database

**禁止**直接讀寫 JSON 檔案。使用 `dataStore.get(key)` / `dataStore.set(key, value)`（JSON）或 `getDatabase()`（SQLite）。

### 規則 3：命令必須透過 CommandRouter 登記

所有命令在 `src/modules/commands.js` 的 `registerAll()` 中登記。

### 規則 4：訊息路由優先級不可變更

### 規則 5：重啟時保留 WhatsApp Session

```bash
# ✅ 正確
taskkill //F //IM node.exe
rm -f .wwebjs_auth/session-pbots-client/SingletonLock
rm -f .wwebjs_auth/session-pbots-client/Default/SingletonLock
npm start

# ❌ 錯誤 — 會破壞已登入的 session
rm -rf .wwebjs_auth/
```

---

## 4. 完整命令列表

| 命令 | 類別 | 權限 | 功能 |
|------|------|------|------|
| `!ping` | 基礎 | 公開 | 測試響應 |
| `!help` | 基礎 | 公開 | 幫助訊息 |
| `!status` | 基礎 | 公開 | 機器人狀態 |
| `!stats` | 基礎 | 公開 | 今日統計 |
| `!weather` / `!天氣` | 資訊 | 公開 | 香港天氣 |
| `!news` / `!新聞` / `!地盤` / `!construction` / `!monitor` / `!監控` / `!accident` / `!意外` | 資訊 | 公開 | 地盤新聞 |
| `!whitelist <密碼>` | 認證 | 公開 | 內聯認證 |
| `!whitelist` | 認證 | 公開 | DM 私信認證流程 |
| `#TOPDF [標題]` | PDF | 管理 | 照片收集→PDF（2×2 A4 網格） |
| `#done` | PDF | 管理 | 完成 PDF 生成 |
| `#cancel` | 通用 | 管理 | 取消當前會話 |
| `#申報` | 考勤 | 管理 | 申報今日工人人數（支援修改） |
| `#今日人數` | 考勤 | 管理 | 查詢今日已申報數據 |
| `#登記判頭` | 考勤 | 管理 | 互動登記判頭（從 Excel 選公司） |
| `#判頭列表` | 考勤 | 管理 | 列出所有已登記判頭 |
| `#移除判頭 [ID]` | 考勤 | 管理 | 移除判頭 |
| `!security` | 管理 | 管理 | 安全狀態報告 |
| `!cleanup` | 管理 | 管理 | 系統清理 |
| `!mediastats` | 管理 | 管理 | 媒體統計 |
| `!addgroup` | 管理 | 管理 | 授權當前群組 |
| `!removegroup [ID]` | 管理 | 管理 | 移除群組授權 |
| `!cleanupwhitelist` | 管理 | 管理 | 重置所有白名單數據 |
| `#Drawing` | 圖紙 | 管理 | 搜尋加工圖（互動多步驟） |
| `#searchpor` | 圖紙 | 管理 | 手動重建圖紙索引 + DeepScan TG 映射 |
| `#dwgfind` / `#找位置圖` / `#findlayout` | 圖紙 | 管理 | 加工圖號 → 反向查詢 TG 位置圖 |
| `#rebuildTg` | 圖紙 | 管理 | 手動重建 TG 位置圖映射 |

---

## 5. 已實作模組

### 5.1 工人考勤（workerAttendance.js）

**排程**：每日 9:00 AM（週一至六）自動觸發，所有已登記判頭收到私訊。

**Excel 寫入**：使用 `exceljs` 保留原有格式、合併儲存格、樣式。

### 5.2 PDF 收集（imageToPdf.js）

`#TOPDF 安全巡查報告` → 私訊收集照片 → `#done` → A4 2×2 網格 PDF。

### 5.3 天氣 + 新聞（weatherReporter.js, newsReporter.js）

香港天文台 API + Google News RSS（cheerio 解析）。

### 5.4 物料圖紙搜尋（drawingSearch.js）

**命令**：`#Drawing` / `#searchpor` / `#dwgfind` / `#rebuildTg`

**核心設計**：SQLite 預建索引 + DeepScan TG 雙向映射。

- **索引搜尋**：52,000+ 檔案，substring 匹配 <10ms
- **物料分類**：FST=鐵料、FAC=鋁板、BGL=玻璃、ACD=鋁板…共 16 類
- **格式選擇**：PDF、DWG、兩方一併下載
- **DWG 文字提取**：libredwg dwgread 直接提取，不需 OCR
- **TG 位置圖對應**：透過 `tg_mapping` 索引，毫秒級查詢
- **反向查詢**：`#dwgfind` 輸入加工圖號 → 找出對應位置圖

**資料庫表**：

| 表 | 說明 |
|----|------|
| `files` | 圖紙索引（52,000+ 筆） |
| `folder_cache` | Folder 級預緩存（TG 檔案列表、大小） |
| `tg_cache` | DWG 內容快取（mtime 檢查，免重複掃描） |
| `tg_mapping` | 繪圖編號 → 位置圖雙向映射（16,000+ 條） |

### 5.5 監控儀表板（monitorServer.js）

`http://localhost:3456` + Web UI（`/drawing` 圖紙搜尋、`/deepscan` TG 掃描進度）。

---

## 6. 技術棧

| 類別 | 技術 | 用途 |
|------|------|------|
| 核心 | whatsapp-web.js v1.34.7 | WhatsApp Web 自動化（puppeteer） |
| 資料庫 | better-sqlite3 | SQLite 圖紙索引 + TG 快取 |
| PDF | pdfkit | A4 PDF 生成 |
| DWG | libredwg (dwgread) | DWG 文字直接提取，100% 準確 |
| Excel | exceljs | 讀寫 .xlsx 並保留格式 |
| 排程 | node-cron | 每日 9:00 AM + 12:00 PM |
| HTTP | axios | 天氣 API、RSS 請求 |
| 解析 | cheerio | HTML/XML 解析 |
| HTTP Server | Node.js http | 內建監控伺服器 |
| 環境 | dotenv | 密碼管理 |
| 日誌 | 自訂 JSONL + SSE | append-only 訊息日誌 + 即時串流 |

**系統依賴**：

- Windows Chrome：`C:/Program Files/Google/Chrome/Application/chrome.exe`
- 中文字體：`tools/fonts/simhei.ttf`
- libredwg：`tools/libredwg/dwgread.exe` + DLL

---

## 7. 新電腦設定

```bash
# 1. 克隆專案
git clone https://github.com/andyau98/Pbots.git
cd Pbots
git checkout master

# 2. 安裝依賴
npm install

# 3. 設定環境變數
cp .env.example .env
# 編輯 .env：AUTH_PASSWORD=你的密碼

# 4. 修改 POR 路徑（每台電腦不同）
# 編輯 configs/settings.json → paths.por

# 5. （可選）從舊電腦複製 WhatsApp session
# 複製 .wwebjs_auth/ 目錄

# 6. 啟動
npm start
# 監控儀表板：http://localhost:3456
```

---

## 8. 監控儀表板

### 端點列表

| Endpoint | 方法 | 說明 |
|----------|------|------|
| `/` | GET | 儀表板主頁（QR Code 或監控面板） |
| `/api/status` | GET | JSON 狀態 API |
| `/api/logs/stream` | GET | SSE 即時日誌串流 |
| `/drawing` | GET | 圖紙搜尋 Web UI |
| `/api/drawing/search` | GET | 圖紙搜尋 API |
| `/api/drawing/download` | GET | 圖紙下載（直接串流） |
| `/deepscan` | GET | TG 位置圖 Deep Scan 進度頁面 |
| `/api/deepscan/progress` | GET | DeepScan 進度 JSON |
| `/api/deepscan/files` | GET | 檔案列表 API |
| `/api/deepscan/download` | GET | 位置圖下載 |
| `/api/deepscan/start` | POST | 手動啟動 DeepScan |
| `/api/deepscan/pause` | POST | 暫停掃描 |
| `/api/deepscan/resume` | POST | 繼續掃描 |

### 儀表板功能

- **6 卡資訊面板**：今日訊息、命令媒體、管理、運行、活躍會話、安全
- **即時日誌**：級別過濾（Info/Warn/Error）、關鍵字搜尋、暫停自動捲動
- **圖紙搜尋頁面**：瀏覽器搜尋 + 系統碼過濾 + 位置圖顯示 + 一鍵下載
- **DeepScan 頁面**：即時進度條 + 檔案層級狀態追蹤 + 暫停/繼續控制

---

## 9. DeepScan TG 位置圖系統

### 目的

預先掃描所有 DWG 位置圖，提取繪圖編號，建立 `tg_mapping` 雙向索引，令 `#dwgfind` 可以毫秒級查出對應位置圖。

### 工作流程

```
buildIndex() 完成 files 表寫入
    │
    ├── folder_cache 保留（唔刪除）
    ├── 清理不存在路徑嘅 folder_cache entries
    │
    └── _rebuildTgMapping()
          ├── 讀取所有 has_tag DWG 檔案（1619 個）
          ├── 按 folder 分組（522 個 folder）
          ├── 比對 folder_cache.tg_file_sizes 判斷 folder 有無變更
          │     ├── 無變更 → 跳過整個 folder
          │     └── 有變更 → 掃描 folder 內每個 DWG
          │           ├── 比對 tg_cache.mtime → 未改動直接讀快取
          │           └── 已改動 → dwgread 提取 → 寫入 tg_cache + tg_mapping
          ├── 清除唔存在檔案嘅 tg_cache entries
          └── 更新 folder_cache.tg_file_sizes
```

### 快取層級

| 層級 | 檢查方式 | 粒度 |
|------|----------|------|
| Folder 級 | `folder_cache.tg_file_sizes` JSON 比對 | 整個 folder |
| File 級 | `tg_cache.mtime` 修改時間比對 | 單一檔案 |
| 內容級 | `tg_mapping` drawing_number 索引 | 單一圖號 |

### 相關 API

- 進度查詢：`GET /api/deepscan/progress`
- 進度 UI：`http://localhost:3456/deepscan`
- 啟動後自動從 DB 還原已完成進度

---

## 10. 待開發模組

| 模組 | 命令 | 功能 | 狀態 |
|------|------|------|------|
| 🔍 瑕疵驗收 | `#瑕疵 [描述]` | 拍照記錄瑕疵、指派責任方、跟進修復 | 規劃中 |
| 🛡️ 安全紀錄 | `#安全巡查` `#工具箱` | 安全巡查、事件上報 | 規劃中 |
| 📊 報表生成 | `#日報` `#週報` | 自動匯總數據生成 PDF | 規劃中 |
| ⚡ 天氣警報 | — | 8號風球/黑雨自動通知全群 | 規劃中 |
| 📦 物料追蹤 | `#登記物料` | 從生產到安裝的完整狀態追蹤 | 規劃中 |
