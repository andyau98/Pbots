# 🤖 PBOTS - WhatsApp 工程管理機器人

PBOTS 是基於 `whatsapp-web.js` + `LocalAuth` 的 WhatsApp 機器人，專為幕牆工地管理設計，涵蓋考勤申報、物料圖紙搜尋、照片 PDF 生成、天氣新聞查詢等功能。

## 🚀 快速開始

```bash
git clone https://github.com/andyau98/Pbots.git
cd Pbots
git checkout master
npm install
cp .env.example .env
# 編輯 .env，設定 AUTH_PASSWORD=你的密碼
npm start
```

首次啟動會在終端顯示 QR Code，用 WhatsApp 掃描登入。登入後 session 會保留，下次啟動無需重新掃碼。

## 📱 完整命令列表

| 命令                                                | 功能                         |
| --------------------------------------------------- | ---------------------------- |
| `!help`                                             | 幫助訊息                     |
| `!ping`                                             | 測試響應                     |
| `!status`                                           | 機器人狀態                   |
| `!stats`                                            | 今日統計                     |
| `!weather` / `!天氣`                                | 香港天氣                     |
| `!news` / `!地盤` / `!construction` / `!monitor` 等 | 地盤意外新聞                 |
| `!whitelist [密碼]`                                 | 管理員認證                   |
| `#TOPDF [標題]`                                     | 照片收集 → 生成 PDF          |
| `#done`                                             | 完成 PDF 收集                |
| `#cancel`                                           | 取消當前會話                 |
| `#申報`                                             | 申報今日工人人數（支援修改） |
| `#今日人數`                                         | 查詢今日各公司申報           |
| `#登記判頭`                                         | 互動式登記判頭               |
| `#判頭列表`                                         | 列出已登記判頭               |
| `#移除判頭 [ID]`                                    | 移除判頭                     |
| `#圖紙 [編號]`                                      | 搜尋物料圖紙 (POR)           |
| `#dwgfind` / `#找位置圖`                            | 輸入加工圖號 → 找對應位置圖  |
| `#searchpor`                                        | 手動重建圖紙索引             |
| `!addgroup` / `!removegroup`                        | 管理授權群組                 |
| `!security` / `!cleanup` / `!mediastats`            | 系統管理                     |
| `!cleanupwhitelist`                                 | 重置所有白名單               |

## 🏗️ 核心功能

### 🕐 工人考勤自動化

- 每日 9:00 AM 自動向已登記判頭發送私訊收集工人人數
- 支援手動 `#申報`（若已報過會顯示原有數字，可修改）
- 數據自動寫入 Excel 範本，保留原有格式

### 🔍 物料圖紙搜尋

- 預建索引策略，支援物料碼前綴分類（FST=鐵料、FAC=鋁板…）
- 模糊匹配，凌晨 3:00 AM 自動重建索引

### 📐 DWG 加工圖 → 位置圖查詢（`#dwgfind`）

- 使用 libredwg 從 DWG 直接提取文字（**100% 準確，不需 OCR**）
- 輸入加工圖號 → 自動找出對應位置圖，可一併發送檔案
- 從 Excel 提料單 + DWG 內容雙重建立 ACD→TG 對照表
- 原有 PDF OCR 邏輯保留作為 fallback

### 📸 照片 → PDF

- `#TOPDF [標題]` 啟動照片收集，發送照片後 `#done` 生成 PDF
- 多張照片自動排版為 A4 網格，支援中文標題

### 🌐 監控儀表板

- 瀏覽器打開 `http://localhost:3456`
- 6 張詳細數據卡片（訊息/命令/管理/運行/會話/安全）
- 即時日誌串流（支援過濾、搜索、暫停捲動）
- 手機響應式適配

## 📁 目錄結構

```
src/
├── index.js              # 主入口
├── core/                 # 核心模組（auth, router, session, datastore, monitor, scheduler）
├── modules/commands.js   # 所有命令登記與處理
skills/                   # 技能模組（workerAttendance, drawingSearch）
tools/                    # 工具模組（logger, media, pdf, weather, news, dwgReader…）
configs/settings.json     # 靜態配置
data/store/               # 持久化數據（admins, blocked, groups, foremen…）
Sample/LabourSummary/     # 考勤 Excel 範本
```

## 🖥️ 監控儀表板

啟動後訪問 `http://localhost:3456`，包含：

- **即時數據面板**：6 張卡片顯示今日訊息/命令/管理/系統資源/活躍會話/安全狀態
- **Terminal 日誌**：SSE 即時串流，支援 Info/Warn/Error 過濾、關鍵字搜索、暫停捲動
- **QR Code 頁面**：未登入時自動顯示掃碼頁面，登入後切換為儀表板

## 🔧 開發

```bash
npm start              # 啟動機器人
npm run lint           # ESLint 檢查
npm run lint:fix       # ESLint 自動修復
npm run format         # Prettier 格式化
npm run format:check   # Prettier 檢查
npm test               # 執行測試
```

詳細架構說明見 [CLAUDE.md](CLAUDE.md)。

## ⚙️ 換電腦設定

```bash
# 1. 修改 POR 圖紙路徑
#    編輯 configs/settings.json → paths.por

# 2. 複製 WhatsApp session（可選，避免重新掃碼）
cp -r ~/舊電腦/.wwebjs_auth ./

# 3. 重新設定 Claude Code 權限
#    .claude/ 目錄已被 gitignore，每台電腦獨立設定
```

## 🐛 常見問題

| 問題             | 解決方法                                             |
| ---------------- | ---------------------------------------------------- |
| Bot 無法啟動     | `pkill -f "node src/index"` 確保舊進程已停止         |
| QR Code 無法掃描 | 刪除 `.wwebjs_auth/` 目錄重新登入                    |
| 中文 PDF 亂碼    | 確認 `/Library/Fonts/Arial Unicode.ttf` 存在 (macOS) |
| 圖紙搜尋報錯     | 確認 `configs/settings.json` 中 `paths.por` 路徑存在 |

## 📄 許可證

MIT License
