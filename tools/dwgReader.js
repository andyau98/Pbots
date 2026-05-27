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

// 追蹤執行中嘅 child PID，kill 時只殺自己嘅 zombie 唔會影響其他並行提取
const _activePids = new Set();

function getDwgreadPath() {
    if (_dwgreadPath === null) {
        _dwgreadPath = findDwgread();
    }
    return _dwgreadPath;
}

// ── DWG 文字提取 ──

/**
 * 修正 dwgread JSON 輸出中嘅非法值（nan、不完整小數等）
 * 只修正明顯係 JSON number 嘅值，唔會破壞字串內容
 */
function fixDwgJson(raw) {
    return raw
        .replace(/:\s*nan\b/g, ': null')
        .replace(/\[\s*nan\b/g, '[ null')
        .replace(/,\s*nan\b/g, ', null')
        // 只修正數字後面嘅不完整小數（如 [1.] → [1.0]），唔會破壞字串文字
        .replace(/(\d)\.(\s*[,\]}\]\)])/g, '$1.0$2');
}

/**
 * 喺 Windows kill dwgread process tree（防止 timeout 後 zombie）
 * @param {number} [pid] - 指定嘅 PID，冇指定時 kill 所有追蹤中嘅 zombie
 */
function killHungDwgread(pid) {
    if (os.platform() !== 'win32') return;
    try {
        if (pid !== undefined) {
            require('child_process').execSync(
                `taskkill //F //PID ${pid} //T 2>nul`,
                { timeout: 3000 }
            );
        } else {
            // 冇指定 PID → kill 所有 known 嘅 active pid（唔會誤殺其他並行提取）
            for (const activePid of _activePids) {
                try {
                    require('child_process').execSync(
                        `taskkill //F //PID ${activePid} //T 2>nul`,
                        { timeout: 3000 }
                    );
                } catch { /* 可能已結束 */ }
            }
        }
    } catch { /* ignore */ }
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

    // 每次執行前 kill 之前殘留嘅 zombie process
    killHungDwgread();

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
        const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const tmpOut = path.join(os.tmpdir(), `dwg_${uniqueId}_${path.basename(dwgPath)}.json`);

        // 自家 timeout 機制（Windows execFile timeout 唔會 kill child process）
        let timedOut = false;
        let childPid = null;
        const timer = setTimeout(() => {
            timedOut = true;
            if (childPid !== null) killHungDwgread(childPid);
            reject(new Error(`dwgread 超時 (${timeout}ms): ${dwgPath}`));
        }, timeout);

        const child = execFile(exe, ['-O', 'minJSON', '-o', tmpOut, dwgPath], {
            timeout: timeout + 5000, // 比自家 timeout 長少少，等 callback 唔會 race
            env,
        }, (err, stdout, stderr) => {
            clearTimeout(timer);
            if (timedOut) return; // 已經 reject 咗

            if (err && !fs.existsSync(tmpOut)) {
                const errMsg = stderr
                    ? stderr.toString('utf-8').slice(0, 300)
                    : err.message;
                reject(new Error(`dwgread 失敗: ${errMsg}`));
                return;
            }
            try {
                let raw = fs.readFileSync(tmpOut, 'utf-8');

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

        // 追蹤 PID 以便精準 kill（唔影響並行提取）
        childPid = child.pid;
        if (childPid) _activePids.add(childPid);

        // 額外保險：child exit 後移除 PID 紀錄
        child.on('exit', () => {
            clearTimeout(timer);
            if (childPid) {
                _activePids.delete(childPid);
                killHungDwgread(childPid);
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
