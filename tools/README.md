# 🔧 tools/ - 輔助工具目錄

此目錄包含 PBOTS 機器人的各種輔助工具和工具類。

## 📋 已實作工具

### common/utils.js — 共用工具函數

- `ensureDir(dirPath)` — 確保目錄存在，不存在則遞迴建立
- `formatFileSize(bytes)` — 格式化檔案大小為可讀字串（B/KB/MB/GB）
- `calculateDirSize(dirPath)` — 遞迴計算目錄下所有檔案的總大小

### messageLogger.js — JSONL 訊息日誌

- Append-only 每日訊息日誌
- 記錄訊息類型（命令、媒體、一般）、發送者、內容
- `getTodayStats()` 提供今日統計供儀表板使用
- `readExistingLogs(logFile)` 讀取歷史日誌用於命令排行

### mediaDownloader.js — 媒體自動下載

- 自動偵測並下載 WhatsApp 訊息中的圖片、文件
- 依檔案類型分類儲存到 `data/images/`

### imageToPdf.js — 照片→PDF

- 收集多張照片生成 A4 2×2 網格 PDF
- 使用 pdfkit + simhei.ttf（Windows）/ Arial Unicode.ttf（macOS）
- 支援自訂標題

### dwgReader.js — DWG 文字提取

- 使用 libredwg 的 `dwgread` 工具直接從 AutoCAD DWG 檔案提取文字
- **不需 OCR，100% 準確**。提取結果包含 MTEXT 和 ATTRIB
- 依賴外部二進位：`tools/libredwg/dwgread.exe`（Windows）
- 支援超大 DWG JSON 掃描模式（>500MB 自動 fallback）
- API：
  - `extractTextFromDwg(path)` → `[{text, entity}]`
  - `extractTextArrayFromDwg(path, timeout)` → `string[]`
  - `isDwgReaderAvailable()` → `boolean`
- Timeout：預設 120 秒，TG 掃描用 60 秒

### cleanup.js — 舊檔案清理

- 定期清理過期媒體、日誌、暫存檔
- 支援自訂保留天數

### healthMonitor.js — 系統健康監控

- 監控訊息數量、錯誤數量、系統資源
- 每 60 秒心跳更新
- 每 24 小時定時健康報告

### errorRecovery.js — 錯誤恢復

- 指數退避重連：基數 1 秒、上限 30 秒、最多 10 次
- 錯誤分類：認證、連接、網絡、權限、檔案、媒體、記憶體、未知

### weatherReporter.js — 香港天氣

- 使用 axios 調用香港天文台 API
- 支援繁體中文回覆

### newsReporter.js + realNewsFetcher.js — 地盤新聞

- Google News RSS + cheerio 解析
- realNewsFetcher.js 從 RSS 提取真實文章 URL
- 過濾香港地盤相關新聞

## 🔧 工具使用方式

### 模組化設計

- 每個工具獨立封裝特定功能
- 透過 `index.js` 的服務容器注入依賴
- 支援依賴注入和配置管理

### 錯誤處理

- 完整的異常處理機制
- 友好的錯誤訊息
- 自動恢復能力（errorRecovery.js）

### 日誌記錄

- 所有 `console.log/warn/error` 自動被 LogStream 攔截
- 推送至監控儀表板 SSE 串流
- 緩存最近 200 條日誌

## 📈 開發指南

### 創建新工具

1. 在 `tools/` 目錄下創建新的 JavaScript 文件
2. 實現工具類和相關方法
3. 在 `src/index.js` 的服務容器中註冊
4. 編寫測試用例
5. 更新此 README

### 工具規範

- 使用 ES6+ 語法
- 支持 async/await 異步操作
- 提供清晰的 API 文檔
- 包含使用示例
