# 📦 envelope/ - 封裝部署目錄

此目錄包含 PBOTS 機器人的封裝和部署相關文件。

## 📁 部署方式

### Windows 一鍵重啟

專案根目錄的 `PBOTS.bat`：
```batch
taskkill /F /IM node.exe
taskkill /F /IM chrome.exe
del /f .wwebjs_auth\session-pbots-client\SingletonLock
del /f .wwebjs_auth\session-pbots-client\Default\SingletonLock
npm start
```

### 手動部署

```bash
# 安裝依賴
npm install

# 設定環境變數
cp .env.example .env
# 編輯 .env → AUTH_PASSWORD=你的密碼

# 啟動服務
npm start
# 監控儀表板：http://localhost:3456
```

## 🔧 環境變數

| 變數 | 說明 |
|------|------|
| `AUTH_PASSWORD` | 管理員認證密碼 |

## 📊 監控端點

- 儀表板：`http://localhost:3456/`
- 圖紙搜尋：`http://localhost:3456/drawing`
- Deep Scan：`http://localhost:3456/deepscan`
- 狀態 API：`http://localhost:3456/api/status`
