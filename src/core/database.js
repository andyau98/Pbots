/**
 * SQLite 資料庫核心模組
 *
 * 取代 JSON 檔案儲存：
 * - files：圖紙索引（原 drawing_index.json）
 * - folder_cache：Folder 層級預緩存（加快位置圖搜尋）
 * - tg_cache：位置圖 DWG 內容快取（原 app.json tg_content_cache）
 */
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'store', 'pbots.db');
let _instance = null;

class AppDatabase {
    constructor(dbPath) {
        this.db = new Database(dbPath || DB_PATH);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this._init();
    }

    _init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                path TEXT UNIQUE NOT NULL,
                system TEXT DEFAULT '',
                systems TEXT DEFAULT '[]',
                por TEXT DEFAULT '',
                materials TEXT DEFAULT '[]',
                has_tag INTEGER DEFAULT 0,
                ext TEXT NOT NULL DEFAULT '',
                folder TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);
            CREATE INDEX IF NOT EXISTS idx_files_ext ON files(ext);
            CREATE INDEX IF NOT EXISTS idx_files_por ON files(por);

            CREATE TABLE IF NOT EXISTS folder_cache (
                folder TEXT PRIMARY KEY,
                drawing_numbers TEXT NOT NULL DEFAULT '[]',
                drawing_files TEXT NOT NULL DEFAULT '[]',
                tg_files TEXT NOT NULL DEFAULT '[]',
                dwg_tg_files TEXT NOT NULL DEFAULT '[]',
                pdf_tg_files TEXT NOT NULL DEFAULT '[]',
                built_at TEXT NOT NULL DEFAULT '',
                accessed_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS tg_cache (
                file_path TEXT PRIMARY KEY,
                drawing_numbers TEXT NOT NULL DEFAULT '[]',
                source_method TEXT NOT NULL DEFAULT '',
                mtime REAL NOT NULL DEFAULT 0,
                cached_at TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS tg_mapping (
                drawing_number TEXT NOT NULL,
                file_path TEXT NOT NULL,
                dwg_path TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (drawing_number, file_path)
            );
            CREATE INDEX IF NOT EXISTS idx_tg_mapping_drawing_number ON tg_mapping(drawing_number);
            CREATE INDEX IF NOT EXISTS idx_tg_mapping_file_path ON tg_mapping(file_path);
        `);
    }

    // ── File index ──

    /** 清空 files 表 */
    clearFiles() {
        this.db.exec('DELETE FROM files');
    }

    /** 批量寫入檔案索引 */
    insertFiles(files) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO files (name, path, system, systems, por, materials, has_tag, ext, folder)
            VALUES (@name, @path, @system, @systems, @por, @materials, @has_tag, @ext, @folder)
        `);
        const insertAll = this.db.transaction((items) => {
            for (const f of items) stmt.run(f);
        });
        insertAll(files);
    }

    /** 讀取全部索引檔案 */
    getAllFiles() {
        return this.db.prepare('SELECT * FROM files ORDER BY name').all();
    }

    /** 取得特定 folder 嘅所有檔案 */
    getFilesByFolder(folder) {
        return this.db.prepare('SELECT * FROM files WHERE folder = ?').all(folder);
    }

    /** 索引總數 */
    getFileCount() {
        return this.db.prepare('SELECT COUNT(*) as count FROM files').get().count;
    }

    // ── Folder cache ──

    /** 讀取 folder 預緩存 */
    getFolderCache(folder) {
        return this.db.prepare('SELECT * FROM folder_cache WHERE folder = ?').get(folder);
    }

    /** 寫入/更新 folder 預緩存 */
    setFolderCache(folder, data) {
        this.db.prepare(`
            INSERT OR REPLACE INTO folder_cache (folder, drawing_numbers, drawing_files, tg_files, dwg_tg_files, pdf_tg_files, built_at, accessed_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT accessed_count FROM folder_cache WHERE folder = ?), 0) + 1)
        `).run(
            folder,
            data.drawing_numbers || '[]',
            data.drawing_files || '[]',
            data.tg_files || '[]',
            data.dwg_tg_files || '[]',
            data.pdf_tg_files || '[]',
            new Date().toISOString(),
            folder
        );
    }

    /** 所有 folder 緩存數量 */
    getFolderCacheCount() {
        return this.db.prepare('SELECT COUNT(*) as count FROM folder_cache').get().count;
    }

    // ── TG cache ──

    /** 讀取 TG 內容快取 */
    getTgCache(filePath) {
        return this.db.prepare('SELECT * FROM tg_cache WHERE file_path = ?').get(filePath);
    }

    /** 寫入 TG 內容快取 */
    setTgCache(filePath, data) {
        this.db.prepare(`
            INSERT OR REPLACE INTO tg_cache (file_path, drawing_numbers, source_method, mtime, cached_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(filePath, data.drawing_numbers, data.source_method, data.mtime, new Date().toISOString());
    }

    /** TG 快取統計 */
    getTgCacheStats() {
        return this.db.prepare(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN drawing_numbers != '[]' THEN 1 ELSE 0 END) as with_content
            FROM tg_cache
        `).get();
    }

    /** 關閉連線 */
    close() {
        this.db.close();
    }

    // ── TG Mapping（預建位置圖索引） ──

    /** 清空 tg_mapping 表 */
    clearTgMapping() {
        this.db.exec('DELETE FROM tg_mapping');
    }

    /**
     * 批次寫入 tg_mapping（使用 transaction）
     * @param {Array<{drawing_number: string, file_path: string, dwg_path: string, updated_at: string}>} entries
     */
    insertTgMapping(entries) {
        if (entries.length === 0) return;
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO tg_mapping (drawing_number, file_path, dwg_path, updated_at)
            VALUES (?, ?, ?, ?)
        `);
        const insertAll = this.db.transaction((items) => {
            for (const e of items) {
                stmt.run(e.drawing_number, e.file_path, e.dwg_path, e.updated_at || new Date().toISOString());
            }
        });
        insertAll(entries);
    }

    /** 根據繪圖編號查詢 TG 映射 */
    getTgMappingByDrawingNumber(number) {
        return this.db.prepare('SELECT * FROM tg_mapping WHERE drawing_number = ?').all(number);
    }

    /** 根據檔案路徑查詢 TG 映射 */
    getTgMappingByFilePath(filePath) {
        return this.db.prepare('SELECT * FROM tg_mapping WHERE file_path = ?').all(filePath);
    }

    /** 刪除特定檔案路徑嘅 TG 映射 */
    deleteTgMappingByFilePath(filePath) {
        this.db.prepare('DELETE FROM tg_mapping WHERE file_path = ?').run(filePath);
    }

    /** TG 映射統計 */
    getTgMappingStats() {
        return this.db.prepare(`
            SELECT COUNT(*) as total, COUNT(DISTINCT file_path) as files,
                   COUNT(DISTINCT drawing_number) as drawing_numbers
            FROM tg_mapping
        `).get();
    }
}

/** 取得全域 DB 實例（singleton） */
function getDatabase(dbPath) {
    if (!_instance) {
        _instance = new AppDatabase(dbPath);
    }
    return _instance;
}

module.exports = { AppDatabase, getDatabase };

