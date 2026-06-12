# 📁 src/ — PBOTS 核心原始碼

## 入口

`index.js` — 主入口：初始化所有服務、WhatsApp 客戶端、訊息路由、生命週期管理。

## 核心模組 (`core/`)

| 檔案                | 職責                                              |
| ------------------- | ------------------------------------------------- |
| `authManager.js`    | 統一權限管理（管理員、群組授權、白名單）          |
| `commandRouter.js`  | 命令路由器：登記 → 解析 → 權限檢查 → 分發         |
| `sessionManager.js` | 互動會話管理（群組私訊分流 + 群組鎖定）           |
| `dataStore.js`      | 統一 JSON 資料層（唯一讀寫入口）                  |
| `database.js`       | SQLite 資料庫（圖紙索引、TG 快取、TG 映射）       |
| `monitorServer.js`  | HTTP 監控儀表板 (localhost:3456) + SSE 日誌串流   |
| `logStream.js`      | Console 攔截 + 即時日誌推送 (EventEmitter)         |
| `scheduler.js`      | node-cron 排程（考勤 9:00 AM / 索引重建 12:00 PM） |

## 命令模組 (`modules/`)

`commands.js` — 所有命令在 `registerAll()` 中透過 CommandRouter 登記。

## 監控儀表板 API 端點

| Endpoint | 方法 | 說明 |
|----------|------|------|
| `/` | GET | HTML 儀表板（QR Code 或 監控面板，自動切換） |
| `/api/status` | GET | JSON 狀態（訊息、安全、健康、系統、會話） |
| `/api/logs/stream` | GET | SSE 即時日誌串流 |
| `/drawing` | GET | 圖紙搜尋 Web UI |
| `/api/drawing/search` | GET | 圖紙搜尋 API（`?q=&system=&page=`） |
| `/api/drawing/systems` | GET | 系統碼列表 |
| `/api/drawing/download` | GET | 圖紙下載（`?path=`，直接串流檔案） |
| `/deepscan` | GET | TG 位置圖 Deep Scan 進度頁面 |
| `/api/deepscan/progress` | GET | DeepScan 進度 JSON（含 fileDetails） |
| `/api/deepscan/files` | GET | 檔案列表（`?status=&page=&pageSize=`） |
| `/api/deepscan/download` | GET | 位置圖下載（`?path=`） |
| `/api/deepscan/start` | POST | 手動啟動 DeepScan |
| `/api/deepscan/pause` | POST | 暫停掃描 |
| `/api/deepscan/resume` | POST | 繼續掃描 |

## 架構詳情

見根目錄 [CLAUDE.md](../CLAUDE.md)。
