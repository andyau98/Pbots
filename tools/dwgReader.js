/**
 * DWG 文字提取工具 — 從 AutoCAD DWG 檔直接提取文字（不需 OCR）
 *
 * 依賴：libredwg 的 dwgread 工具
 *   - Windows: libredwg-0.13.4-win64.zip (已含在 repo tools/libredwg/)
 *
 * 用法：
 *   const { extractTextFromDwg } = require('../tools/dwgReader');
 *   const texts = await extractTextFromDwg('/path/to/file.dwg');
 *   // → [{ text: 'ACB-ACD-0060', entity: 'ATTRIB' }, ...]
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── libredwg 路徑檢測 ──
function findDwgread() {
    const platform = os.platform();
    const candidates = [];

    if (platform === 'win32') {
        // Windows: libredwg 放在 tools/libredwg/
        candidates.push(
            path.join(__dirname, 'libredwg', 'dwgread.exe'),
            path.join(__dirname, '..', 'tools', 'libredwg', 'dwgread.exe')
        );
    } else if (platform === 'darwin') {
        // macOS: 自行編譯後的路徑
        candidates.push(
            '/tmp/libredwg-0.13.4/programs/.libs/dwgread',
            '/usr/local/bin/dwgread'
        );
    } else {
        // Linux
        candidates.push('/usr/local/bin/dwgread', '/usr/bin/dwgread');
    }

    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

// 已快取路徑
let _dwgreadPath = null;

function getDwgreadPath() {
    if (_dwgreadPath === null) {
        _dwgreadPath = findDwgread();
    }
    return _dwgreadPath;
}

// ── DWG 文字提取 ──

/**
 * 修正 dwgread JSON 輸出中嘅非法值（nan、不完整小數等）
 */
function fixDwgJson(raw) {
    return raw
        .replace(/:\s*nan\b/g, ': null')
        .replace(/\[\s*nan\b/g, '[ null')
        .replace(/,\s*nan\b/g, ', null')
        .replace(/\.(?=[\s,\}\]])/g, '.0');
}

/**
 * 執行 dwgread 並回傳 JSON
 * @param {string} dwgPath - DWG 檔案路徑
 * @param {number} [timeout=120000] - 超時時間（毫秒）
 */
function runDwgread(dwgPath, timeout = 120000) {
    const exe = getDwgreadPath();
    if (!exe) {
        return Promise.reject(new Error('找不到 dwgread 工具。請安裝 libredwg。'));
    }

    return new Promise((resolve, reject) => {
        // Windows: 將 libredwg 目錄加入 PATH 以便載入 DLL
        const env = { ...process.env };
        const exeDir = path.dirname(exe);
        if (os.platform() === 'win32') {
            env.PATH = exeDir + path.delimiter + (env.PATH || '');
        } else if (os.platform() === 'darwin') {
            const libDir = exeDir.replace('programs', 'src');
            env.DYLD_LIBRARY_PATH = (env.DYLD_LIBRARY_PATH || '') + ':' + libDir;
        }

        // 輸出到暫存檔（避免 stdout buffer 上限 + 處理效率）
        const tmpOut = path.join(os.tmpdir(), `dwg_${Date.now()}_${path.basename(dwgPath)}.json`);
        execFile(exe, ['-O', 'minJSON', '-o', tmpOut, dwgPath], {
            timeout,
            env,
        }, (err, stdout, stderr) => {
            if (err && !fs.existsSync(tmpOut)) {
                const errMsg = stderr
                    ? stderr.toString('utf-8').slice(0, 300)
                    : err.message;
                reject(new Error(`dwgread 失敗: ${errMsg}`));
                return;
            }
            try {
                let raw = fs.readFileSync(tmpOut, 'utf-8');
                cleaned = true;

                // 修正 libredwg 0.13.4 JSON 輸出嘅問題（nan、不完整小數）
                raw = fixDwgJson(raw);

                const data = JSON.parse(raw);
                resolve(data);
            } catch (e) {
                reject(new Error(`JSON 解析失敗: ${e.message}`));
            } finally {
                try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
            }
        });
    });
}

/**
 * 從 DWG JSON 中提取所有文字
 */
function parseDwgJson(data) {
    const objects = data.OBJECTS || [];

    // handle → object 索引
    const handleMap = new Map();
    for (const obj of objects) {
        const h = obj.handle;
        if (h && Array.isArray(h)) {
            handleMap.set(h.join(','), obj);
        }
    }

    const results = [];

    for (const obj of objects) {
        const entity = obj.entity || '';
        const dwgType = obj.type;

        // MTEXT: 多行文字（清除格式標籤）
        if (entity === 'MTEXT' || dwgType === 44) {
            const text = obj.text || '';
            if (text && text.trim()) {
                let clean = text.replace(/\{[^}]*\}/g, '');    // {\fSimSun|...}
                clean = clean.replace(/\\P/g, '\n');
                clean = clean.replace(/\\[A-Za-z][^;]*;/g, '');
                if (clean.trim()) {
                    results.push({ text: clean.trim(), entity: 'MTEXT' });
                }
            }
        }

        // INSERT: 圖塊引用 → 文字在 attribs 子物件中
        if (entity === 'INSERT' && obj.has_attribs && Array.isArray(obj.attribs)) {
            for (const ah of obj.attribs) {
                if (!Array.isArray(ah)) continue;
                const attr = handleMap.get(ah.join(','));
                if (attr) {
                    const text = attr.text || attr.text_value || '';
                    if (text && String(text).trim()) {
                        results.push({
                            text: String(text).trim(),
                            entity: 'ATTRIB',
                        });
                    }
                }
            }
        }

        // 獨立的 ATTRIB / ATTDEF
        if (entity === 'ATTRIB' || entity === 'ATTDEF' || dwgType === 33 || dwgType === 34) {
            const text = obj.text || obj.text_value || '';
            if (text && String(text).trim()) {
                results.push({
                    text: String(text).trim(),
                    entity: entity || `type_${dwgType}`,
                });
            }
        }
    }

    return results;
}

/**
 * 從 DWG 檔提取所有文字
 * @param {string} dwgPath - DWG 檔案路徑
 * @param {number} [timeout] - dwgread 超時時間（毫秒），預設 120s
 * @returns {Promise<Array<{text: string, entity: string}>>}
 */
async function extractTextFromDwg(dwgPath, timeout) {
    const data = await runDwgread(dwgPath, timeout);
    return parseDwgJson(data);
}

/**
 * 從 DWG 提取文字並回傳純文字陣列
 * @param {string} dwgPath
 * @param {number} [timeout] - dwgread 超時時間（毫秒），預設 120s
 * @returns {Promise<string[]>}
 */
async function extractTextArrayFromDwg(dwgPath, timeout) {
    const entries = await extractTextFromDwg(dwgPath, timeout);
    return [...new Set(entries.map(e => e.text))];
}

/**
 * 檢查 DWG reader 是否可用
 */
function isDwgReaderAvailable() {
    return getDwgreadPath() !== null;
}

module.exports = {
    extractTextFromDwg,
    extractTextArrayFromDwg,
    isDwgReaderAvailable,
    getDwgreadPath,
};
