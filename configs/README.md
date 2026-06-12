# ⚙️ configs/ - 配置檔案目錄

此目錄包含 PBOTS 機器人的配置檔案。

## 📄 文件說明

### settings.json — 主要配置檔案

| 設定項 | 說明 |
|--------|------|
| `project` | 名稱、版本、描述 |
| `paths.por` | **POR 物料圖紙目錄**（Z: 網絡磁碟機或本地路徑） |
| `paths.*` | 其他路徑配置（src、tools、data 等） |
| `bot.prefix` | 命令前綴（預設 `!`，hash 命令用 `#`） |
| `bot.name` | 機器人名稱 |
| `features.reply_in_group` | 群組中是否回覆非 whitelist 命令 |
| `features.*` | 功能開關（QR登入、會話持久化等） |
| `security.whitelist_enabled` | 白名單模式開關 |
| `security.*` | 認證、允許群組、封鎖用戶設定 |
| `logging` | 日誌級別、檔案路徑、大小限制 |

## 🔧 配置載入

配置文件在 `src/index.js` 啟動時自動載入。路徑依賴：

- `.env` — 敏感資料（`AUTH_PASSWORD`）
- `configs/settings.json` — 靜態設定
- `data/store/*.json` — 可變數據

## 🔒 換電腦注意

切換電腦時必須修改 `paths.por` 以符合本機或網絡磁碟機路徑：

```json
{
    "paths": {
        "por": "Z:/POR/01 POR ISAAC"
    }
}
```
