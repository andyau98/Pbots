/**
 * DWG 文字提取工具 — 從 AutoCAD DWG 檔直接提取文字（不需 OCR）
 *
 * 依賴：libredwg 的 dwgread 工具
 *   - Windows: libredwg-0.13.4-win64.zip (已含在 repo tools/libredwg/)
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
        candidates.push(
            path.join(__dirname, 'libredwg', 'dwgread.exe'),
            path.join(__dirname, '..', 'tools', 'libredwg', 'dwgread.exe')
        );
    } else if (platform === 'darwin') {
        candidates.push(
            '/tmp/libredwg-0.13.4/programs/.libs/dwgread',
            '/usr/local/bin/dwgread'
        );
    } else {
        candidates.push('/usr/local/bin/dwgread', '/usr/bin/dwgread');
    }

    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

let _dwgreadPath = null;
const _activePids = new Set();

function getDwgreadPath() {
    if (_dwgreadPath === null) _dwgreadPath = findDwgread();
    return _dwgreadPath;
}

// ── 文字提取 ──

/** 修正 dwgread JSON 輸出中嘅非法值（nan / NaN、不完整小數） */
function fixDwgJson(raw) {
    return raw
        .replace(/:\s*nan\b/gi, ': null')
        .replace(/\[\s*nan\b/gi, '[ null')
        .replace(/,\s*nan\b/gi, ', null')
        .replace(/(\d)\.(\s*[,\]}\]\)])/g, '$1.0$2');
}

/** 喺 Windows kill dwgread process tree */
function killHungDwgread(pid) {
    if (os.platform() !== 'win32') return;
    try {
        if (pid !== undefined) {
            require('child_process').execSync(`taskkill //F //PID ${pid} //T 2>nul`, { timeout: 3000 });
        } else {
            for (const activePid of _activePids) {
                try { require('child_process').execSync(`taskkill //F //PID ${activePid} //T 2>nul`, { timeout: 3000 }); } catch {}
            }
        }
    } catch {}
}

/**
 * 核心：執行 dwgread 並解析 JSON，回傳 {data, stderr, exitCode}
 * ERROR 0x1000（網絡磁碟機）直接回傳 null data，交由 runDwgread fallback 處理
 */
function _runDwgreadOnce(inputPath, jsonOutputPath, timeout) {
    const exe = getDwgreadPath();
    if (!exe) throw new Error('找不到 dwgread 工具');

    // ✅ 一律先抄到本機暫存，繞過 ERROR 0x1000
    // 抄完之後嘅 local copy 完全冇網絡磁碟機問題
    let actualInput = inputPath;
    let localCopy = null;

    try {
        const localId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const safeExt = path.extname(inputPath).toLowerCase();
        localCopy = path.join(os.tmpdir(), `dwg_local_${localId}${safeExt}`);
        fs.copyFileSync(inputPath, localCopy);
        actualInput = localCopy;
    } catch (copyErr) {
        console.error(`  ❌ 複製檔案到本機失敗: ${copyErr.message}`);
        return Promise.resolve({ data: null, stderr: 'local_copy_failed: ' + copyErr.message, exitCode: -1 });
    }

    const env = { ...process.env };
    const exeDir = path.dirname(exe);
    if (os.platform() === 'win32') {
        env.PATH = exeDir + path.delimiter + (env.PATH || '');
    } else if (os.platform() === 'darwin') {
        env.DYLD_LIBRARY_PATH = (env.DYLD_LIBRARY_PATH || '') + ':' + exeDir.replace('programs', 'src');
    }

    return new Promise((_resolve) => {
        let timedOut = false, childPid = null;
        const timer = setTimeout(() => {
            timedOut = true;
            if (childPid) killHungDwgread(childPid);
            _resolve({ data: null, stderr: 'timeout', exitCode: -1 });
        }, timeout);

        const child = execFile(exe, ['-O', 'minJSON', '-o', jsonOutputPath, actualInput], {
            timeout: timeout + 15000, env,
        }, (err, _stdout, stderrRaw) => {
            clearTimeout(timer);
            if (timedOut) return;

            // ✅ 本地複製用完即刪
            if (localCopy) {
                try { fs.unlinkSync(localCopy); } catch {}
            }

            const stderrStr = stderrRaw ? stderrRaw.toString('utf-8') : '';
            const exitCode = err ? (err.code || 1) : 0;

            // ERROR 0x1000 — 不應再出現（已先複製到本機），但仍保留 fallback
            if (stderrStr.includes('ERROR 0x1000')) {
                _resolve({ data: null, stderr: stderrStr, exitCode });
                return;
            }

            if (err && !fs.existsSync(jsonOutputPath)) {
                _resolve({ data: null, stderr: stderrStr, exitCode });
                return;
            }
            try {
                const stat = fs.statSync(jsonOutputPath);
                let data;
                try {
                    let raw = fs.readFileSync(jsonOutputPath, 'utf-8');
                    raw = fixDwgJson(raw);
                    data = JSON.parse(raw);
                } catch (parseErr) {
                    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
                    if (parseErr.message?.includes('Cannot create a string longer than')) {
                        console.log(`  ⚠️ 超大 JSON (${sizeMb}MB)，用掃瞄模式提取文字`);
                    } else {
                        console.log(`  ⚠️ JSON 解析失敗 (${sizeMb}MB)，改用掃瞄模式提取文字`);
                    }
                    data = scanHugeJson(jsonOutputPath);
                }
                _resolve({ data, stderr: stderrStr, exitCode });
            } catch (e) {
                _resolve({ data: null, stderr: stderrStr, exitCode });
            } finally {
                // 提取完成後即時刪除暫存 JSON
                const jsonSize = fs.existsSync(jsonOutputPath) ? (fs.statSync(jsonOutputPath).size / 1024 / 1024).toFixed(1) : 0;
                try { fs.unlinkSync(jsonOutputPath); } catch {}
                if (parseFloat(jsonSize) > 100) {
                    console.log(`  🧹 已清理 ${jsonSize}MB 暫存 JSON`);
                }
            }
        });

        childPid = child.pid;
        if (childPid) _activePids.add(childPid);
        child.on('exit', () => {
            clearTimeout(timer);
            if (childPid) { _activePids.delete(childPid); killHungDwgread(childPid); }
        });
    });
}

/**
 * 執行 dwgread 並回傳 JSON（含 Z: 網絡磁碟機 fallback）
 */
async function runDwgread(dwgPath, timeout = 120000) {
    const exe = getDwgreadPath();
    if (!exe) throw new Error('找不到 dwgread 工具');

    killHungDwgread();

    const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const tmpOut = path.join(os.tmpdir(), `dwg_${uniqueId}_${path.basename(dwgPath)}.json`);

    // 網絡路徑已由 _runDwgreadOnce 內部自動複製到本機，直接執行即可
    let result = await _runDwgreadOnce(dwgPath, tmpOut, timeout);

    if (!result.data) {
        throw new Error(`dwgread 失敗: ${result.stderr.slice(0, 300) || `exit ${result.exitCode}`}`);
    }
    return result.data;
}

// ── JSON 解析 ──

function parseDwgJson(data) {
    const objects = data.OBJECTS || [];
    const handleMap = new Map();
    for (const obj of objects) {
        const h = obj.handle;
        if (h && Array.isArray(h)) handleMap.set(h.join(','), obj);
    }

    const results = [];

    for (const obj of objects) {
        const entity = obj.entity || '';
        const dwgType = obj.type;
        const hasText = obj.text && String(obj.text).trim();

        // MTEXT
        if (entity === 'MTEXT' || dwgType === 44) {
            const text = obj.text || '';
            if (text && text.trim()) {
                let clean = text.replace(/\{[^}]*\}/g, '');
                clean = clean.replace(/\\P/g, '\n');
                clean = clean.replace(/\\[A-Za-z][^;]*;/g, '');
                if (clean.trim()) results.push({ text: clean.trim(), entity: 'MTEXT' });
            }
        }

        // INSERT → attribs
        if (entity === 'INSERT' && obj.has_attribs && Array.isArray(obj.attribs)) {
            for (const ah of obj.attribs) {
                if (!Array.isArray(ah)) continue;
                const attr = handleMap.get(ah.join(','));
                if (attr) {
                    const text = attr.text || attr.text_value || '';
                    if (text && String(text).trim()) {
                        results.push({ text: String(text).trim(), entity: 'ATTRIB' });
                    }
                }
            }
        }

        // ATTRIB / ATTDEF
        if (entity === 'ATTRIB' || entity === 'ATTDEF' || dwgType === 33 || dwgType === 34) {
            const text = obj.text || obj.text_value || '';
            if (text && String(text).trim()) {
                results.push({ text: String(text).trim(), entity: entity || `type_${dwgType}` });
            }
        }

        // scanHugeJson fallback
        if (entity === 'SCANNED' || (!entity && !dwgType && hasText)) {
            results.push({ text: String(obj.text).trim(), entity: 'SCANNED' });
        }
    }

    return results;
}

/**
 * 掃瞄超大 JSON 檔案提取文字（避開 V8 string limit ~512MB）
 */
function scanHugeJson(filePath) {
    const fd = fs.openSync(filePath, 'r');
    const CHUNK = 128 * 1024;
    const fileSize = fs.statSync(filePath).size;
    const objects = [];
    let overlap = Buffer.alloc(0);
    const seen = new Set();

    try {
        for (let offset = 0; offset < fileSize; offset += CHUNK) {
            const chunkSize = Math.min(CHUNK, fileSize - offset);
            const chunk = Buffer.alloc(chunkSize);
            fs.readSync(fd, chunk, 0, chunkSize, offset);
            const searchBuf = Buffer.concat([overlap, chunk]);
            const searchEnd = Math.max(0, searchBuf.length - 500);
            const searchStr = searchBuf.slice(0, searchEnd).toString('utf-8');

            let idx = 0;
            while (idx < searchStr.length) {
                const textStart = searchStr.indexOf('"text": "', idx);
                if (textStart < 0) break;
                const valStart = textStart + 9;
                const valEnd = searchStr.indexOf('"', valStart);
                if (valEnd < 0) break;
                const textVal = searchStr.substring(valStart, valEnd).trim();
                if (textVal && !seen.has(textVal)) {
                    seen.add(textVal);
                    objects.push({ entity: 'SCANNED', text: textVal });
                }
                idx = valEnd + 1;
            }
            overlap = searchBuf.slice(searchEnd);
        }
    } finally {
        fs.closeSync(fd);
    }

    return { OBJECTS: objects };
}

/** 清理孤兒暫存檔（上次 crash 遺留） */
function cleanupOrphanedTempFiles() {
    try {
        const tmpDir = os.tmpdir();
        const entries = fs.readdirSync(tmpDir);
        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;
        let cleanedCount = 0, freedBytes = 0;

        for (const entry of entries) {
            if (!entry.startsWith('dwg_') && !entry.startsWith('dwg_in_')) continue;
            const fullPath = path.join(tmpDir, entry);
            try {
                const s = fs.statSync(fullPath);
                if (now - s.mtimeMs > ONE_HOUR) {
                    freedBytes += s.size;
                    fs.unlinkSync(fullPath);
                    cleanedCount++;
                }
            } catch {}
        }

        if (cleanedCount > 0) {
            console.log(`🧹 清理 ${cleanedCount} 個孤兒暫存檔，釋放 ${(freedBytes / 1024 / 1024).toFixed(1)} MB`);
        }
    } catch {}
}

// ── 公開 API ──

async function extractTextFromDwg(dwgPath, timeout) {
    const data = await runDwgread(dwgPath, timeout);
    return parseDwgJson(data);
}

async function extractTextArrayFromDwg(dwgPath, timeout) {
    const entries = await extractTextFromDwg(dwgPath, timeout);
    return [...new Set(entries.map(e => e.text))];
}

function isDwgReaderAvailable() {
    return getDwgreadPath() !== null;
}

module.exports = {
    extractTextFromDwg,
    extractTextArrayFromDwg,
    isDwgReaderAvailable,
    getDwgreadPath,
    cleanupOrphanedTempFiles,
};
