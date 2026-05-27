/**
 * 統一資料層（DataStore）
 *
 * 所有可變／持久化數據的唯一讀寫入口。
 * 主程式及任何模組都透過 DataStore 操作數據，不直接讀寫檔案。
 *
 * 資料目錄結構：
 *   data/store/admins.json   — 管理員列表
 *   data/store/blocked.json  — 已封鎖用戶
 *   data/store/groups.json   — 授權群組
 *   data/store/app.json      — 擴展用（運行時狀態）
 *   data/exports/            — 統一輸出路徑
 */

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('../../tools/common/utils');

class DataStore {
    constructor() {
        // 資料根目錄
        this._dataDir = path.join(__dirname, '../../data');
        this._storeDir = path.join(this._dataDir, 'store');
        this._exportDir = path.join(this._dataDir, 'exports');

        // 確保目錄存在
        ensureDir(this._storeDir);
        ensureDir(this._exportDir);

        // 內存快取
        this._cache = new Map();

        console.log('🗄️  DataStore 已初始化');
    }

    // ========== 通用 JSON 讀寫（含記憶體快取） ==========

    /**
     * 從 store 讀取 JSON 資料（有 2 秒記憶體快取）
     * @param {string} filename - 不含路徑（例如 'admins.json'）
     * @param {*} defaultValue - 檔案不存在時的預設值
     */
    _read(filename, defaultValue = null) {
        const filePath = path.join(this._storeDir, filename);
        const now = Date.now();

        // 快取命中 + 未過期（2秒）
        const cached = this._cache.get(filename);
        if (cached && (now - cached.ts) < 2000) {
            return cached.data;
        }

        try {
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                this._cache.set(filename, { data, ts: now });
                return data;
            }
        } catch (error) {
            console.error(
                `❌ DataStore 讀取失敗 (${filename}):`,
                error.message
            );
        }
        // 讀取失敗但快取有舊數據 → 用舊數據
        if (cached) return cached.data;
        return defaultValue;
    }

    /**
     * 寫入 JSON 資料到 store（同時更新快取）
     */
    _write(filename, data) {
        const filePath = path.join(this._storeDir, filename);
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            this._cache.set(filename, { data, ts: Date.now() });
            return true;
        } catch (error) {
            console.error(
                `❌ DataStore 寫入失敗 (${filename}):`,
                error.message
            );
            return false;
        }
    }

    // ========== 管理員 ==========

    /** 獲取管理員列表 */
    getAdmins() {
        return this._read('admins.json', []);
    }

    /** 添加管理員 */
    addAdmin(userId) {
        const admins = this.getAdmins();
        if (!admins.includes(userId)) {
            admins.push(userId);
            this._write('admins.json', admins);
        }
        return admins;
    }

    /** 移除管理員 */
    removeAdmin(userId) {
        let admins = this.getAdmins();
        admins = admins.filter((a) => a !== userId);
        this._write('admins.json', admins);
        return admins;
    }

    /** 檢查是否為管理員 */
    isAdmin(userId) {
        return this.getAdmins().includes(userId);
    }

    // ========== 封鎖用戶 ==========

    /** 獲取封鎖列表 */
    getBlockedUsers() {
        return this._read('blocked.json', []);
    }

    /** 封鎖用戶 */
    blockUser(userId, reason = '') {
        const blocked = this.getBlockedUsers();
        if (!blocked.find((b) => b.userId === userId)) {
            blocked.push({
                userId,
                reason,
                blockedAt: new Date().toISOString(),
            });
            this._write('blocked.json', blocked);
        }
        return blocked;
    }

    /** 解除封鎖 */
    unblockUser(userId) {
        let blocked = this.getBlockedUsers();
        blocked = blocked.filter((b) => b.userId !== userId);
        this._write('blocked.json', blocked);
        return blocked;
    }

    /** 檢查是否被封鎖 */
    isBlocked(userId) {
        return this.getBlockedUsers().some((b) => b.userId === userId);
    }

    // ========== 授權群組 ==========

    /** 獲取授權群組列表 */
    getAuthorizedGroups() {
        return this._read('groups.json', []);
    }

    /** 添加授權群組 */
    addAuthorizedGroup(groupId) {
        const groups = this.getAuthorizedGroups();
        if (!groups.includes(groupId)) {
            groups.push(groupId);
            this._write('groups.json', groups);
        }
        return groups;
    }

    /** 移除授權群組 */
    removeAuthorizedGroup(groupId) {
        let groups = this.getAuthorizedGroups();
        groups = groups.filter((g) => g !== groupId);
        this._write('groups.json', groups);
        return groups;
    }

    // ========== 通用鍵值儲存（擴展用） ==========

    /**
     * 讀取任意鍵值（從 app.json）
     * 用於日後新增數據類型時不用改 DataStore
     */
    get(key, defaultValue = undefined) {
        const appData = this._read('app.json', {});
        return key in appData ? appData[key] : defaultValue;
    }

    /**
     * 寫入任意鍵值（到 app.json）
     * 只讀一次 app.json，唔再 double read
     */
    set(key, value) {
        const filename = 'app.json';
        const appData = this._read(filename, {});
        appData[key] = value;
        return this._write(filename, appData);
    }

    /**
     * 刪除鍵值
     */
    delete(key) {
        const filename = 'app.json';
        const appData = this._read(filename, {});
        delete appData[key];
        return this._write(filename, appData);
    }

    // ========== 統一輸出 ==========

    /**
     * 將內容寫入統一輸出路徑 (data/exports/)
     * @param {string} filename - 輸出檔名
     * @param {string|Buffer} content - 內容
     * @returns {string} 完整檔案路徑
     */
    exportFile(filename, content) {
        const filePath = path.join(this._exportDir, path.normalize(filename));
        // 路徑穿越防護：確保最終路徑仍然喺 export 目錄內
        if (!filePath.startsWith(this._exportDir)) {
            throw new Error('無效嘅匯出路徑');
        }
        fs.writeFileSync(filePath, content);
        console.log(`📤 DataStore 匯出: ${filePath}`);
        return filePath;
    }

    /**
     * 取得輸出路徑（不寫入，僅回傳路徑）
     */
    getExportPath(filename) {
        return path.join(this._exportDir, filename);
    }

    /** 取得統一輸出的目錄 */
    getExportDir() {
        return this._exportDir;
    }

    // ========== 整機重置 ==========

    /**
     * 重置所有數據（清空管理員、封鎖、群組、app 資料）
     */
    resetAll() {
        this._write('admins.json', []);
        this._write('blocked.json', []);
        this._write('groups.json', []);
        this._write('app.json', {});
        this._cache.clear();
        console.log('🔄 DataStore 已重置');
    }

    /**
     * 取得完整狀態摘要
     */
    getSummary() {
        return {
            adminCount: this.getAdmins().length,
            blockedCount: this.getBlockedUsers().length,
            groupCount: this.getAuthorizedGroups().length,
            appKeys: Object.keys(this._read('app.json', {})),
        };
    }
}

// 單例
const dataStore = new DataStore();

module.exports = { DataStore, dataStore };
