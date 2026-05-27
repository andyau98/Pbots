# PBOTS `#Drawing` 功能現狀 — 供 Gemini 開發用

本文檔完整描述 PBOTS WhatsApp Bot 嘅 `#Drawing`（圖紙搜尋）功能嘅實現細節，方便 Gemini 理解現有架構後協助開發。

---

## 一、功能概述

`#Drawing` 係一個**多步驟互動式圖紙搜尋系統**，用於幕牆工地嘅物料加工圖查詢：

- 資料來源：POR 目錄（`configs/settings.json` → `paths.por`，如 `V:/POR/01 POR ISAAC`）
- 搜尋方式：**空格分隔多條件 AND 搜尋**（物料碼 + 系統碼 + 關鍵字可混搭）
- 索引策略：**SQLite 預建索引**，啟動時掃描 POR 目錄一次，後續查詢只讀 SQLite
- 儲存層：`better-sqlite3` → `data/store/pbots.db`
- 位置圖提取：**DWG-only 策略**（libredwg dwgread 直接提取，100% 準確，不需 OCR）

---

## 二、完整狀態機流程

```
input (用戶輸入關鍵字)
  │
  ├── [結果 > 20?] ──→ filter_material (揀物料碼)
  │                         │
  │                    [系統碼 > 1?] ──→ filter_system (揀系統碼)
  │                         │
  └── [≤ 20 或跳過篩選] ←───┘
                            │
                            ↓
                     select (揀 PDF 圖紙，數字選擇)
                            │
                     [有同名 DWG?] ──→ select_format (揀 PDF/DWG/両方)
                            │                 │
                     [冇 DWG] ←─────────────────┘
                            │
                            ↓
                    scanAndShowTg (自動掃描位置圖 DWG)
                            │
                     select_tg (揀位置圖，數字/逗號分隔)
                            │       │
                     show_detail ────┘ (v 鍵詳細對比)
                            │
                            ↓
                     send (發送加工圖 + 位置圖)
```

每個步驟支援：
- `#R` → 返回上一層
- `#cancel` → 取消

---

## 三、檔案結構與職責

### 核心檔案

| 檔案 | 職責 |
|------|------|
| `skills/drawingSearch.js` (1260行) | **主模組**：索引建立、搜尋、TG 掃描、SessionManager handler |
| `src/core/database.js` (163行) | **SQLite 封裝**：`files`、`folder_cache`、`tg_cache` 三張表 |
| `tools/dwgReader.js` (223行) | **DWG 文字提取**：呼叫 libredwg dwgread 外部二進位 |
| `src/modules/commands.js` (commands.js) | **命令登記**：`#Drawing`、`#searchpor`、`#dwgfind` 三個命令 |

### 命令登記 (commands.js)

```js
// #Drawing — 主搜尋流程
router.register('Drawing', drawingHandler, { requireAuth: true, isHash: true, aliases: ['圖紙'] });

// #searchpor — 手動重建索引
router.register('searchpor', rebuildIndexHandler, { requireAuth: true, isHash: true, aliases: ['重建索引'] });

// #dwgfind — 反向查詢（加工圖號→位置圖）
router.register('dwgfind', dwgFindHandler, { requireAuth: true, isHash: true, aliases: ['找位置圖', 'findlayout'] });
```

所有 handlers 經由 `sessionManager.start()` 啟動，透過 `SessionManager` 管理多步驟互動。

---

## 四、SQLite 資料庫 Schema

Database path: `data/store/pbots.db`
Singleton 存取：`getDatabase()`

### files 表 — 圖紙索引

```sql
CREATE TABLE files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,          -- 檔名（如 FHA760.HGRH-WWB0102-ACD1226.pdf）
    path        TEXT UNIQUE NOT NULL,   -- 完整路徑
    system      TEXT DEFAULT '',        -- 主系統碼（如 ACD、FST）
    systems     TEXT DEFAULT '[]',      -- JSON 陣列，所有系統碼
    por         TEXT DEFAULT '',        -- POR 子目錄名
    materials   TEXT DEFAULT '[]',      -- JSON 陣列，物料碼
    has_tag     INTEGER DEFAULT 0,      -- 是否有同名 TG 位置圖
    ext         TEXT NOT NULL DEFAULT '',   -- 副檔名
    folder      TEXT NOT NULL DEFAULT ''    -- 資料夾路徑
);
CREATE INDEX idx_files_folder ON files(folder);
CREATE INDEX idx_files_ext ON files(ext);
CREATE INDEX idx_files_por ON files(por);
```

### folder_cache 表 — Folder 級預緩存

```sql
CREATE TABLE folder_cache (
    folder           TEXT PRIMARY KEY,         -- 資料夾路徑
    drawing_numbers  TEXT NOT NULL DEFAULT '[]', -- 該 folder 內所有繪圖編號
    drawing_files    TEXT NOT NULL DEFAULT '[]', -- 加工圖檔案列表
    tg_files         TEXT NOT NULL DEFAULT '[]', -- 位置圖檔案列表
    dwg_tg_files     TEXT NOT NULL DEFAULT '[]', -- DWG 格式位置圖
    pdf_tg_files     TEXT NOT NULL DEFAULT '[]', -- PDF 格式位置圖
    built_at         TEXT NOT NULL DEFAULT '',   -- 建立時間
    accessed_count   INTEGER NOT NULL DEFAULT 0  -- 存取次數
);
```

### tg_cache 表 — TG DWG 內容快取

```sql
CREATE TABLE tg_cache (
    file_path       TEXT PRIMARY KEY,          -- DWG 檔案路徑
    drawing_numbers TEXT NOT NULL DEFAULT '[]', -- 提取到的繪圖編號
    source_method   TEXT NOT NULL DEFAULT '',   -- 提取方法（dwg_direct）
    mtime           REAL NOT NULL DEFAULT 0,    -- 檔案修改時間
    cached_at       TEXT NOT NULL DEFAULT ''    -- 快取時間
);
```

### tg_mapping 表 — 預建位置圖索引（2026-05-23 新增）

```sql
CREATE TABLE tg_mapping (
    drawing_number TEXT NOT NULL,     -- 繪圖編號（如 ACD1226）
    file_path      TEXT NOT NULL,     -- TG 檔案路徑（DWG 或 PDF）
    dwg_path       TEXT NOT NULL DEFAULT '',  -- 實際被掃描嘅 DWG 路徑
    updated_at     TEXT NOT NULL DEFAULT '',  -- 更新時間
    PRIMARY KEY (drawing_number, file_path)
);
CREATE INDEX idx_tg_mapping_drawing_number ON tg_mapping(drawing_number);
CREATE INDEX idx_tg_mapping_file_path ON tg_mapping(file_path);
```

**作用：** 取代原先搜尋時即時掃描 DWG 嘅做法，改為 `buildIndex` 時預先提取所有繪圖編號並存入此表。查詢時直接 `SELECT file_path FROM tg_mapping WHERE drawing_number = ?`，響應時間由數秒降至毫秒級。

---

## 五、索引建立邏輯 (`buildIndex` / `scanDirectory`)

### 觸發時機
1. **啟動時**：`drawingSearch.js` 被 `commands.js` require 時自動呼叫 `loadIndex()`
2. **排程**：每日凌晨 3:00（`src/core/scheduler.js`）
3. **手動**：管理員發送 `#searchpor`

### 檔案掃描 (`scanDirectory`)
- 遞迴掃描 `paths.por` 目錄
- 接受的副檔名：`.pdf`, `.dwg`, `.dxf`, `.jpg`, `.png`, `.tiff`, `.tif`
- 排除小於 100 bytes 的無效檔案

### 系統碼提取邏輯（重點）
從檔名 token 中自動提取系統碼和物料碼：

```
檔名範例：FHA760.HGRH-WWB0102-ACD1226.pdf

Token 拆解：["FHA760", "HGRH", "WWB0102", "ACD1226"]

邏輯：
1. 每個 token 提取字母前綴（FHA, HGRH, WWB, ACD）
2. 比對 MATERIAL_CODES 表 → 決定邊啲係物料碼 vs 系統碼
3. HGRH 係「項目碼」，排在佢前面嘅係「字頭物料」，後面嘅係「系統碼」

primarySystem 決定邏輯：
- 如果 allCodes 第一個係 HGRH → projectIdx = 1（取第二個當系統碼）
- 否則 projectIdx = 0（取第一個當系統碼）
- materials = HGRH 之前嘅碼 + HGRH 之後嘅碼
```

### MATERIAL_CODES 分類表（16 類）

```js
FST: '鐵料',    FAC: '鋁板',    BOM: '雜件/型材', BBF: '螺絲',
FFA: '防水片/收口角', BGK: '墊塊',  FHU: '加工組裝件', BGL: '玻璃',
FHA: '鋁料加工件',    FSS: '不鏽鋼', HGRH: '鋁型材',   ACD: '鋁板',
UN: '單元',    AP: '防水片',   JMA: '鋁角',  MSB: '鐵角',
MSA: '鐵碼',   MSH: '鐵Hollow'
```

### has_tag 判斷
- 如果檔名包含 `_TG`、`-TG` 或大寫 `TAG` → `has_tag = 1`
- 否則掃描同一目錄，檢查有無以該檔名為基礎嘅 TG 檔案

---

## 六、搜尋演算法 (`searchDrawings`)

### 輸入處理
```
輸入：'ACA FAC 123'
→ tokens = ['ACA', 'FAC', '123']
→ matCodes = ['FAC']           (在 MATERIAL_CODES 表內)
→ generalCodes = ['ACA']       (2-4 位大寫字母，不在物料表)
→ keywords = ['123']           (其他)
```

### 特殊處理：混合 Token
```
輸入：'ACD1226'
→ regex 匹配：MATERIAL_CODES 有 ACD → splitMat = 'ACD', splitKw = '1226'
→ matCodes = ['ACD'], keywords = ['1226']
```

### 匹配規則（AND）
```js
for (const kw of keywords)
    if (!name.includes(kw)) return false;  // 檔名必須包含所有關鍵字
for (const mc of matCodes)
    if (!materials.includes(mc)) return false;  // 物料碼必須匹配
for (const gc of generalCodes)
    // 系統碼 OR 物料碼 OR 檔名包含 → 任一符合即可
```

---

## 七、DWG 文字提取 (`tools/dwgReader.js`)

### 依賴
- **Windows**：`tools/libredwg/dwgread.exe`（已附在 repo）+ DLL 需在 PATH
- **macOS**：`/tmp/libredwg-0.13.4/programs/.libs/dwgread` 或 `/usr/local/bin/dwgread`
- **Linux**：`/usr/local/bin/dwgread` 或 `/usr/bin/dwgread`

### 提取流程
```bash
# dwgread 輸出 minJSON 到暫存檔
dwgread -O minJSON -o /tmp/dwg_xxx.json input.dwg
```

### 解析邏輯 (`parseDwgJson`)
從 dwgread JSON 輸出中提取三類文字：
1. **MTEXT**（entity=44）：多行文字，清除 `{\fSimSun|...}` 等格式標籤
2. **INSERT.attribs**：圖塊引用嘅 ATTRIB 屬性文字（透過 handle 查找）
3. **獨立 ATTRIB/ATTDEF**（type=33/34）

### 已知問題
- libredwg 0.13.4 的 JSON 輸出包含 `nan` 等非法值 → `fixDwgJson()` 用 regex 修正
- 大型 DWG 需要較長時間 → timeout 預設 120 秒（TG 掃描用 60 秒）
- Windows DLL 依賴：執行時需將 `tools/libredwg/` 加入 PATH

---

## 八、TG 位置圖掃描流程（重構後：索引先行）

### 階段 0：Deep Scan（索引建立時執行）
在 `buildIndex()` 的 `scanDirectory()` 完成後，自動執行 `_rebuildTgMapping()`：

1. 從 SQLite `files` 表讀取所有 `has_tag = 1` 且 `ext = '.dwg'` 的檔案
2. 對每個 DWG 檔案：
   - 檢查 `tg_cache` 的 `mtime` → 若檔案未改動則直接讀取快取
   - 若已改動 → 呼叫 `dwgReader.extractTextArrayFromDwg()` 提取文字
   - 用正則從文字提取所有繪圖編號
   - 同時為 companion PDF 建立對應的 mapping entry
3. 批次寫入 `tg_mapping` 表（使用 `db.transaction` 確保原子性）

### 查詢階段：`_queryTgFromIndex()`（取代 `scanTgFilesForDrawing()`）

```js
// 新版：直接 SQL 查詢，毫秒級響應
function _queryTgFromIndex(tagFiles, targetNumbers) {
    const db = getDb();
    // 對每個目標繪圖編號查 tg_mapping
    for (const num of uniqueTargets) {
        const rows = db.getTgMappingByDrawingNumber(num);
        // 比對 rows.file_path 是否在 tagFiles 列表中
        if (tagFileSet.has(row.file_path)) {
            // → 匹配成功，標記 relevance: 'exact'
        }
    }
}
```

### 雙層匹配策略（保留，改用索引）
```js
// 第 1 層：只用所選單一圖號做匹配
const specificNumbers = extractDrawingNumbers(ctx.selectedBase);
let relevant = _queryTgFromIndex(tagFiles, specificNumbers);  // 毫秒級

// 第 2 層：fallback 到整個 folder
if (!hasExact && useSpecific) {
    const fallback = _queryTgFromIndex(tagFiles, folderNumbers);
}
```

### 繪圖編號正則
```js
const DRAWING_NUMBER_RE = /[A-Z]{2,4}[-_]?(?:[A-Z])?\d{3,6}/g;
// 匹配範例：ACD1226, ACB-ACD-0060, FHA760, WWB0102, HGRH-WWB0102-ACD1226
// 清理後統一格式：移除 [-_]，轉大寫
```

### 增量更新：`incrementalTgUpdate(folderPath)`
- 單資料夾層級重新掃描，唔影響全量索引
- 檢查每個 DWG 的 `mtime` vs `tg_cache`，只掃有變更的檔案
- 刪除舊 mapping → 插入新 mapping
- 可透過 `checkAndUpdateTgFolder()` 自動檢測並觸發

### `scanTgFilesForDrawing()` 保留但不再被主流程呼叫
- 仍然存在於 `module.exports` 中，供除錯或手動使用
- 主搜尋流程 (`_scanAndShowRelevantTg`) 已完全改用 `_queryTgFromIndex()`

---

## 九、反向查詢 `#dwgfind`

### 功能
輸入加工圖號 → 反向尋找對應嘅 TG 位置圖（與 `#Drawing` 相反方向）

### 流程
1. 用戶輸入圖號（如 `ACD0060`）
2. `findLayoutByFabNumber()` 掃描記憶體 index
3. 對每個 index entry 檢查檔名是否包含目標圖號
4. 找到後檢查該 folder 有無 TG 檔案（`getTagFiles`）
5. 顯示位置圖列表、問用戶是否需要發送

---

## 十、發送機制 (`_buildSendResult`)

最終結果包含三類檔案，按優先級排序發送：

```
1. 精確匹配嘅 TG DWG（bold）+ 同名 TG PDF
2. 其他位置圖檔案（DWG + PDF pair）
3. 用戶選擇嘅加工圖（PDF + 可選 DWG/DXF）

→ 全部作為 attachments 傳遞俾 SessionManager
→ SessionManager 逐一發送（支援多附件）
→ 發送完成後發 completionMessage: '✅ 已完成所有發送'
```

### 附件處理
SessionManager 使用 `_createMediaFromFile()` 將本地檔案轉為 `MessageMedia`：
- `.dwg`、`.dxf` 等 CAD 檔案作為 `application/octet-stream` 發送
- `.pdf` 直接發送 PDF

---

## 十一、已知問題同 Edge Cases

1. **檔案編碼問題**：檔名可能包含簡體中文或特殊字元，提取系統碼時需小心
2. **HGRH 優先規則**：HGRH 作為項目碼，系統碼取第二個 token（唔係第一個）
3. **TG/TAG 判斷**：`_TG`、`-TG`、`TAG` 都當作位置圖標記
4. **DWG companion**：同一檔名嘅 PDF 同 DWG 可能同時存在，需要 pair 發送
5. **記憶體索引**：`_cachedIndex` 常駐記憶體（GC 唔會回收），大型 POR 目錄可能佔用大量 RAM
6. **folder_cache 永久有效**：SQLite 快取唔會自動過期，只有 `#searchpor` 重建時才 DELETE FROM folder_cache
7. **dwgread JSON bug**：libredwg 0.13.4 輸出 `nan` 字串，唔係 JSON 標準 → 需要 `fixDwgJson()`
8. **多頁 TG**：只有 `show_detail` 階段支援逐頁檢視繪圖編號
9. **逗號分隔多選**：TG 選擇支援 `1,3,5` 格式，但 PDF 選擇只支援單一數字
10. **群組鎖定**：所有 `#Drawing` 經 SessionManager 鎖定群組，其他人無法干擾會話
11. **tg_mapping 需預先建立**：第一次搜尋或 `#searchpor` 後才會觸發 Deep Scan。如果 tg_mapping 為空，位置圖匹配會顯示「無匹配」
12. **Deep Scan 失敗不影響主索引**：`_rebuildTgMapping()` 若有錯誤（如 DWG 損壞），只記錄到 log，唔會中斷 `buildIndex()` 流程
13. **增量更新只檢查 mtime**：`incrementalTgUpdate()` 依賴 `tg_cache.mtime` 判斷檔案有冇變化，若檔案被複製取代（mtime 重置），會重新掃描

---

## 十二、開發注意事項

1. **新增命令** → 必須在 `commands.js` 的 `registerAll()` 登記，使用 SessionManager handler
2. **新儲存欄位** → 修改 `database.js` 嘅 `_init()` 同對應 accessor 方法
3. **測試 dwgread** → `tools/dwgReader.js` 嘅 `isDwgReaderAvailable()` 檢查二進位是否存在
4. **索引重建** → 修改 `scanDirectory()` 後必須同步更新 `database.js` 嘅 `insertFiles()` 對應欄位
5. **物料碼分類** → 修改 `MATERIAL_CODES` 後會影響搜尋的 token 分類邏輯
