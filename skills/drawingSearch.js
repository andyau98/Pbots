/**
 * 物料圖紙搜尋模組 (Drawing Search)
 *
 * - SQLite 儲存索引 + folder 預緩存 + TG DWG 快取
 * - DWG-only 位置圖內容提取（取消 PDF OCR）
 * - 格式選擇（PDF/DWG/兩方）下載
 * - Folder 級預緩存，加快位置圖搜尋速度
 */
const fs = require('fs');
const path = require('path');
const { extractTextArrayFromDwg, isDwgReaderAvailable } = require('../tools/dwgReader');
const { getDatabase } = require('../src/core/database');

function getDb() { return getDatabase(); }

// 繪圖編號正則：2-4 大寫字母 + 可選分隔符 + 可選字母前綴 + 3-6 位數字
const DRAWING_NUMBER_RE = /[A-Z]{2,4}[-_]?(?:[A-Z])?\d{3,6}/g; // eslint-disable-line no-unused-vars

// TG 排除詞（用於從檔名提取系統碼時排除）
const TG_EXCLUDE = new Set([
    'TG', 'TAG', 'RF', 'FOR', 'AND', 'THE', 'NEW', 'OLD',
    'POR', 'ISO', 'DWG', 'PDF', 'DXF', 'JPG', 'PNG', 'TIFF', 'TIF',
]);

// 常駐記憶體快取
let _cachedIndex = null;
let _indexLoaded = false;

// 物料碼分類
const MATERIAL_CODES = {
    FST: '鐵料', FAC: '鋁板', BOM: '雜件/型材', BBF: '螺絲',
    FFA: '防水片/收口角', BGK: '墊塊', FHU: '加工組裝件', BGL: '玻璃',
    FHA: '鋁料加工件', FSS: '不鏽鋼', HGRH: '鋁型材', ACD: '鋁板',
    UN: '單元', AP: '防水片', JMA: '鋁角', MSB: '鐵角', MSA: '鐵碼',
    MSH: '鐵Hollow',
};

// ========== 索引建立 ==========

/**
 * 遞迴掃描目錄，建立索引
 */
function scanDirectory(dirPath) {
    const results = [];
    if (!fs.existsSync(dirPath)) return results;

    const EXCLUDE_SYSTEMS = new Set([
        'TG', 'TAG', 'RF', 'FOR', 'AND', 'THE', 'NEW', 'OLD',
        'POR', 'ISO', 'ASS', 'DWG', 'PDF', 'DXF', 'JPG', 'PNG', 'TIFF', 'TIF',
    ]);

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                results.push(...scanDirectory(fullPath));
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (['.pdf', '.dwg', '.dxf', '.jpg', '.png', '.tiff', '.tif'].includes(ext)) {
                    const name = entry.name;
                    const upperName = name.toUpperCase();

                    const allCodes = [];
                    const tokens = upperName.replace(/\.[^.]+$/, '').split(/[-_]+/);
                    for (const token of tokens) {
                        const clean = token.replace(/\d.*$/, '');
                        if (/^[A-Z]{2,4}$/.test(clean) && !EXCLUDE_SYSTEMS.has(clean)) {
                            if (!allCodes.includes(clean)) allCodes.push(clean);
                        }
                        const codeMatch = token.match(/^([A-Z]{2,4})\d/);
                        if (codeMatch && !EXCLUDE_SYSTEMS.has(codeMatch[1]) && !allCodes.includes(codeMatch[1])) {
                            allCodes.push(codeMatch[1]);
                        }
                    }

                    let projectIdx = 0;
                    if (allCodes.length > 1 && allCodes[0] === 'HGRH') projectIdx = 1;
                    const primarySystem = allCodes.length > projectIdx ? allCodes[projectIdx] : '';
                    const systems = primarySystem ? [primarySystem] : [];
                    const beforeProject = allCodes.slice(0, projectIdx).filter(c => !EXCLUDE_SYSTEMS.has(c));
                    const afterProject = allCodes.slice(projectIdx + 1).filter(c => !EXCLUDE_SYSTEMS.has(c));
                    const materials = [...beforeProject, ...afterProject];
                    const system = systems.length > 0 ? systems[0] : '';

                    const porMatch = fullPath.match(/POR[/\\][^/\\]+[/\\]([^/\\]+)/i);
                    const por = porMatch ? porMatch[1] : '';

                    let hasTag = false;
                    if (upperName.includes('_TG') || upperName.includes('-TG') || upperName.includes('TAG')) {
                        hasTag = true;
                    } else {
                        try {
                            const dirEntries = fs.readdirSync(dirPath);
                            const base = path.basename(name, ext);
                            const baseUpper = base.toUpperCase();
                            hasTag = dirEntries.some(f =>
                                f !== name &&
                                (f.toUpperCase().includes('_TG') || f.toUpperCase().includes('-TG') || f.toUpperCase().includes('TAG')) &&
                                (f.toUpperCase().includes(baseUpper) || baseUpper.includes(f.replace(/[-_]TG.*$/i, '').replace(/\.[^.]+$/, '').toUpperCase()))
                            );
                        } catch { /* ignore */ }
                    }

                    results.push({ name, path: fullPath, system, systems, por, materials, hasTag });
                }
            }
        }
    } catch (e) {
        console.error(`❌ 掃描目錄失敗 (${dirPath}):`, e.message);
    }
    return results;
}

/**
 * 建立索引並寫入 SQLite
 */
async function buildIndex(porPath) {
    console.log(`🔍 開始建立圖紙索引: ${porPath}`);
    const start = Date.now();

    const index = scanDirectory(porPath);
    const db = getDb();

    // 寫入 SQLite
    db.clearFiles();
    db.insertFiles(index.map(f => ({
        name: f.name,
        path: f.path,
        system: f.system || '',
        systems: JSON.stringify(f.systems || []),
        por: f.por || '',
        materials: JSON.stringify(f.materials || []),
        has_tag: f.hasTag ? 1 : 0,
        ext: path.extname(f.name).toLowerCase(),
        folder: path.dirname(f.path),
    })));

    // 清空舊 folder 快取（路徑可能已變）
    db.db.exec('DELETE FROM folder_cache');

    // 更新記憶體快取
    _cachedIndex = index;
    _indexLoaded = true;

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✅ 索引建立完成: ${index.length} 個檔案, 耗時 ${elapsed}s`);

    // 階段 2：Deep Scan — 預先建立 TG 位置圖映射（用 tg_mapping 表）
    try {
        const tgResult = await _rebuildTgMapping(porPath);
        console.log(`   TG 映射: ${tgResult.totalMappings} 條 (掃描 ${tgResult.scannedCount} / 快取 ${tgResult.cachedCount})`);
    } catch (tgErr) {
        // Deep Scan 失敗唔影響主索引
        console.error('⚠️ Deep Scan TG 映射失敗:', tgErr.message);
    }

    return { fileCount: index.length, elapsed };
}

/** 載入索引到記憶體（從 SQLite） */
function loadIndex() {
    if (_indexLoaded && _cachedIndex) return _cachedIndex;
    try {
        const allFiles = getDb().getAllFiles();
        _cachedIndex = allFiles.map(f => ({
            ...f,
            systems: JSON.parse(f.systems || '[]'),
            materials: JSON.parse(f.materials || '[]'),
        }));
        _indexLoaded = true;
        console.log(`📂 圖紙索引已載入: ${_cachedIndex.length} 個檔案`);
        return _cachedIndex;
    } catch (e) {
        console.error('❌ 載入索引失敗:', e.message);
    }
    return [];
}

// ========== 搜尋 ==========

/** 空格分隔多條件 AND 搜尋（物料碼 + 通用碼 + 關鍵字） */
function searchDrawings(query) {
    const index = loadIndex();
    if (!index.length) return [];

    const tokens = query.trim().toUpperCase().split(/\s+/).filter(Boolean);
    const matCodes = [];
    const generalCodes = [];
    const keywords = [];

    for (const t of tokens) {
        if (MATERIAL_CODES[t]) {
            matCodes.push(t);
        } else if (/^[A-Z]{2,4}$/.test(t)) {
            generalCodes.push(t);
        } else {
            let splitMat = null;
            let splitKw = t;
            const matMatch = t.match(/^([A-Z]{2,4})[-_]?(\d.*)$/);
            if (matMatch && MATERIAL_CODES[matMatch[1]]) {
                splitMat = matMatch[1];
                splitKw = matMatch[2].replace(/[-_]/g, '');
            }
            if (splitMat) {
                matCodes.push(splitMat);
                if (splitKw) keywords.push(splitKw);
            } else {
                keywords.push(t);
            }
        }
    }

    return index.filter(f => {
        const name = f.name.toUpperCase();
        for (const kw of keywords) { if (!name.includes(kw)) return false; }
        for (const mc of matCodes) { if (!f.materials || !f.materials.includes(mc)) return false; }
        for (const gc of generalCodes) {
            const matchSys = f.system === gc;
            const matchMat = f.materials && f.materials.includes(gc);
            const matchName = name.includes(gc);
            if (!matchSys && !matchMat && !matchName) return false;
        }
        return true;
    });
}

/** 提取出現的物料碼及其數量 */
function extractMaterialCodes(results) {
    const codes = {};
    for (const f of results) {
        if (f.materials && f.materials.length) {
            for (const code of f.materials) codes[code] = (codes[code] || 0) + 1;
        }
    }
    return Object.entries(codes).sort((a, b) => b[1] - a[1]);
}

/** 提取出現的系統碼及其數量 */
function extractSystemCodes(results) {
    const codes = {};
    for (const f of results) {
        const src = f.systems && f.systems.length ? f.systems : f.system ? [f.system] : [];
        for (const s of src) codes[s] = (codes[s] || 0) + 1;
    }
    return Object.entries(codes).sort((a, b) => b[1] - a[1]);
}

/** 取得同目錄所有 TG 檔案（優先 SQLite index，fallback 到 directory scan） */
function getTagFiles(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const baseUpper = base.toUpperCase();

    // 優先 SQLite index（快，毫秒級）
    if (_indexLoaded && _cachedIndex) {
        const folderFiles = _cachedIndex.filter(f => f.folder === dir);
        const results = [];
        for (const f of folderFiles) {
            const name = f.name;
            const upper = name.toUpperCase();
            if (
                name !== path.basename(filePath) &&
                !upper.endsWith('.DWL') &&
                (upper.includes('_TG') || upper.includes('-TG') || upper.includes('TAG')) &&
                (upper.includes(baseUpper) || baseUpper.includes(name.replace(/[-_]TG.*$/i, '').replace(/\.[^.]+$/, '')))
            ) {
                results.push(f.path);
            }
        }
        return results;
    }

    // fallback：directory scan（當 index 未 load）
    const results = [];
    try {
        const entries = fs.readdirSync(dir);
        for (const f of entries) {
            const upper = f.toUpperCase();
            if (
                f !== path.basename(filePath) &&
                !upper.endsWith('.DWL') &&
                (upper.includes('_TG') || upper.includes('-TG') || upper.includes('TAG')) &&
                (upper.includes(baseUpper) || baseUpper.includes(f.replace(/[-_]TG.*$/i, '').replace(/\.[^.]+$/, '')))
            ) {
                results.push(path.join(dir, f));
            }
        }
    } catch { /* ignore */ }
    return results;
}

function getTagFile(filePath) {
    const files = getTagFiles(filePath);
    return files.length > 0 ? files[0] : null;
}

/** 同目錄 TG 位置圖查找 */
function resolveTgFiles(filePath) {
    return getTagFiles(filePath);
}

/** 找同名但不同副檔名的檔案（如 PDF → DWG） */
function findMatchingFile(filePath, targetExt) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const target = path.join(dir, base + targetExt);
    if (fs.existsSync(target)) return target;
    try {
        const entries = fs.readdirSync(dir);
        const want = (base + targetExt).toUpperCase();
        for (const f of entries) {
            if (f.toUpperCase() === want) return path.join(dir, f);
        }
    } catch { /* ignore */ }
    return null;
}

// ========== TG 位置圖內容掃描 ==========

/** 從文字中提取所有繪圖編號 */
function extractDrawingNumbers(text) {
    const matches = new Set();
    let m;
    DRAWING_NUMBER_RE.lastIndex = 0;
    while ((m = DRAWING_NUMBER_RE.exec(text)) !== null) {
        matches.add(m[0].replace(/[-_]/g, '').toUpperCase());
    }
    return [...matches];
}

/** 提取繪圖編號嘅「系統前綴」 */
function getSystemPrefix(drawingNumber) {
    const m = drawingNumber.match(/^([A-Z]{2,4})/);
    return m ? m[1] : '';
}

/** 格式化繪圖編號：ACD1226 → ACD-1226 */
function fmtDrawingNumber(n) {
    const m = n.match(/^([A-Z]+)(\d+)$/);
    return m ? m[1] + '-' + m[2] : n;
}

/** 從檔名提取純字母系統碼 */
function extractLetterCodes(filename) {
    const upper = filename.toUpperCase();
    const tokens = upper.split(/[-_\s.]+/);
    const codes = [];
    for (const token of tokens) {
        if (/^[A-Z]{2,4}$/.test(token) && !TG_EXCLUDE.has(token)) codes.push(token);
    }
    return codes;
}

/**
 * Section 對比（DWG only）：列出 TG 檔案級別繪圖編號
 */
async function scanTgSections(tgFilePaths, targetNumbers = []) {
    const results = [];

    for (const tgPath of tgFilePaths) {
        const ext = path.extname(tgPath).toLowerCase();
        const name = path.basename(tgPath);

        if (ext === '.dwg' && isDwgReaderAvailable()) {
            try {
                const texts = await extractTextArrayFromDwg(tgPath);
                const allText = texts.join(' ');
                const dwgNumbers = extractDrawingNumbers(allText.toUpperCase());
                const matchedNumbers = targetNumbers.filter(n =>
                    dwgNumbers.some(dn => dn === n || dn.includes(n) || n.includes(dn))
                );
                results.push({
                    path: tgPath, name,
                    totalNumbers: [...new Set(dwgNumbers)].length,
                    matchedNumbers,
                    pageMatches: matchedNumbers.length > 0
                        ? [{ pageNum: 1, matchCount: matchedNumbers.length, matchedNumbers }]
                        : [],
                    pages: [{ pageNum: 1, numberCount: [...new Set(dwgNumbers)].length, numbers: [...new Set(dwgNumbers)].slice(0, 20) }],
                    sourceMethod: 'dwg_direct',
                });
            } catch (err) {
                console.error(`❌ DWG section 讀取失敗 (${tgPath}):`, err.message);
            }
        } else if (ext === '.pdf') {
            // PDF 位置圖（無 DWG companion）→ 只顯示基本資訊
            results.push({
                path: tgPath, name,
                totalNumbers: 0, matchedNumbers: [],
                pageMatches: [], pages: [],
            });
        }
    }

    return results;
}

/**
 * 掃描 TG 檔案，用 DWG 提取繪圖編號匹配目標圖號
 * @param {string[]} tgFilePaths - TG 檔案路徑列表
 * @param {string[]} targetNumbers - 目標繪圖編號
 */
async function scanTgFilesForDrawing(tgFilePaths, targetNumbers = []) {
    const results = [];
    const uniqueTargets = [...new Set(
        (targetNumbers || []).map(n => n.replace(/[-_]/g, '').toUpperCase())
    )];

    const total = tgFilePaths.length;
    for (let idx = 0; idx < total; idx++) {
        const tgPath = tgFilePaths[idx];
        const ext = path.extname(tgPath).toLowerCase();
        const name = path.basename(tgPath);

        console.log(`🔍 掃描位置圖 ${idx+1}/${total}: ${name}`);
        const scanStart = Date.now();

        if (ext === '.dwg') {
            // 獨立 DWG 位置圖 → dwgread 提取
            if (!isDwgReaderAvailable()) {
                results.push({ path: tgPath, name, relevance: 'available', matchedNumbers: [] });
                continue;
            }
            try {
                // TG 掃描用 60s timeout，避免卡死
                const texts = await extractTextArrayFromDwg(tgPath, 60000);
                const allText = texts.join(' ');
                const dwgNumbers = extractDrawingNumbers(allText.toUpperCase());

                // 寫入 tg_cache
                const db = getDb();
                try {
                    const stat = fs.statSync(tgPath);
                    db.setTgCache(tgPath, {
                        drawing_numbers: JSON.stringify([...new Set(dwgNumbers)]),
                        source_method: 'dwg_direct',
                        mtime: stat.mtimeMs,
                    });
                } catch { /* 快取非必要 */ }

                const matches = uniqueTargets.filter(t => dwgNumbers.some(n => n === t));
                if (matches.length > 0) {
                    results.push({
                        path: tgPath, name, relevance: 'exact',
                        matchedNumbers: matches.slice(0, 15),
                        sourceMethod: 'dwg_direct',
                    });
                    console.log(`✅ DWG 匹配: ${name} → ${matches.join(', ')}`);
                } else {
                    results.push({ path: tgPath, name, relevance: 'available', matchedNumbers: [] });
                }
            } catch (err) {
                results.push({ path: tgPath, name, relevance: 'available', matchedNumbers: [] });
            }
        } else if (ext === '.pdf') {
            // PDF 位置圖：跳過掃描，DWG 已提供足夠資訊
            results.push({ path: tgPath, name, relevance: 'available', matchedNumbers: [] });
        }

        const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
        console.log(`   ✓ ${name} (${elapsed}s)`);
    }

    results.sort((a, b) => {
        const order = { exact: 0, available: 2 };
        return (order[a.relevance] || 9) - (order[b.relevance] || 9);
    });
    return results;
}

/** 取得 TG 內容快取統計（從 SQLite） */
function getTgCacheStats() {
    try {
        const stats = getDb().getTgCacheStats();
        return { total: stats.total || 0, withContent: stats.with_content || 0 };
    } catch {
        return { total: 0, withContent: 0 };
    }
}

// ========== Deep Scan：TG 位置圖預建索引 ==========

/** Deep Scan 進度追蹤（供監控 UI 查詢） */
const _deepscanProgress = {
    running: false, total: 0, current: 0, currentFile: '',
    scannedCount: 0, cachedCount: 0, errorCount: 0,
    mappingCount: 0, dwgCount: 0, startTime: null, phase: ''
};

/**
 * Deep Scan：遍歷所有 has_tag DWG 檔案，預先提取繪圖編號並寫入 tg_mapping
 * - 利用 tg_cache 嘅 mtime 檢查，避免重複掃描未改動嘅檔案
 * - 每條 mapping 記錄圖號 → TG 檔案路徑嘅雙向關係
 * - 同時為 DWG 同 companion PDF 建立 mapping entry
 *
 * @param {string} porPath - POR 目錄（只用於日誌，實際從 SQLite files 表讀取）
 * @returns {Promise<{dwgCount: number, totalMappings: number, scannedCount: number, cachedCount: number}>}
 */
async function _rebuildTgMapping(porPath) {
    if (!isDwgReaderAvailable()) {
        console.warn('  ⚠️ DWG Reader 不可用，跳過 Deep Scan TG 映射');
        return { dwgCount: 0, totalMappings: 0, scannedCount: 0, cachedCount: 0 };
    }

    console.log('🔍 Deep Scan: 建立 TG 位置圖映射...');
    const db = getDb();
    const allFiles = db.getAllFiles();

    // 過濾出 has_tag = 1 嘅 DWG 檔案
    const dwgFiles = allFiles.filter(f => f.has_tag && f.ext === '.dwg');
    if (dwgFiles.length === 0) {
        console.log('  ⚠️ 沒有需要掃描嘅 DWG 位置圖');
        return { dwgCount: 0, totalMappings: 0, scannedCount: 0, cachedCount: 0 };
    }

    console.log(`  📄 ${dwgFiles.length} 個 DWG 位置圖需要掃描`);

    // 初始化進度追蹤
    _deepscanProgress.running = true;
    _deepscanProgress.total = dwgFiles.length;
    _deepscanProgress.current = 0;
    _deepscanProgress.currentFile = '';
    _deepscanProgress.scannedCount = 0;
    _deepscanProgress.cachedCount = 0;
    _deepscanProgress.errorCount = 0;
    _deepscanProgress.mappingCount = 0;
    _deepscanProgress.dwgCount = dwgFiles.length;
    _deepscanProgress.phase = '掃描 DWG...';
    _deepscanProgress.startTime = new Date().toISOString();

    const BATCH_SIZE = 50;       // 每 50 個檔案 batch save
    const KEEP_PATHS = new Set(); // 追蹤有效路徑（俾 tg_cache cleanup 用）
    let scannedCount = 0;
    let cachedCount = 0;
    let errorCount = 0;
    let batchAccum = 0;

    // 清空舊 mapping（用 transaction 保護，確保全有或全無）
    const tx = db.db.transaction(() => {
        db.clearTgMapping();
    });
    try { tx(); } catch (e) {
        console.error('  ❌ 清空舊 tg_mapping 失敗:', e.message);
        _deepscanProgress.running = false;
        return { dwgCount: 0, totalMappings: 0, scannedCount: 0, cachedCount: 0, errorCount: 1 };
    }

    try {
        for (const f of dwgFiles) {
            _deepscanProgress.current++;
            _deepscanProgress.currentFile = f.name;
            try {
                const stat = fs.statSync(f.path);
                const cached = db.getTgCache(f.path);

                // mtime 快取檢查（避免重複掃描未改動檔案）
                const isFresh = cached &&
                    cached.drawing_numbers &&
                    cached.drawing_numbers !== '[]' &&
                    Math.abs(Number(cached.mtime) - stat.mtimeMs) < 1;

                let numbers = [];
                if (isFresh) {
                    numbers = JSON.parse(cached.drawing_numbers);
                    cachedCount++;
                } else {
                    const texts = await extractTextArrayFromDwg(f.path, 60000);
                    const allText = texts.join(' ');
                    numbers = extractDrawingNumbers(allText.toUpperCase());

                    // 更新 tg_cache
                    db.setTgCache(f.path, {
                        drawing_numbers: JSON.stringify(numbers),
                        source_method: 'dwg_direct',
                        mtime: stat.mtimeMs,
                    });
                    scannedCount++;
                    _deepscanProgress.scannedCount = scannedCount;
                }

                if (numbers.length === 0) continue;

                KEEP_PATHS.add(f.path);

                // 為每個繪圖編號建立 mapping（DWG 路徑）
                const now = new Date().toISOString();
                const batchMappings = [];
                for (const num of numbers) {
                    batchMappings.push({
                        drawing_number: num,
                        file_path: f.path,
                        dwg_path: f.path,
                        updated_at: now,
                    });
                }

                // 也為 companion PDF 建立 mapping（如有）
                const pdfPath = f.path.replace(/\.dwg$/i, '.pdf').replace(/\.DWG$/, '.PDF');
                if (fs.existsSync(pdfPath)) {
                    KEEP_PATHS.add(pdfPath);
                    for (const num of numbers) {
                        batchMappings.push({
                            drawing_number: num,
                            file_path: pdfPath,
                            dwg_path: f.path,
                            updated_at: now,
                        });
                    }
                }

                // 逐批 insert（避免一鑊過 280K+ 耗 memory）
                db.insertTgMapping(batchMappings);
                batchAccum += batchMappings.length;
                _deepscanProgress.mappingCount += batchMappings.length;

            } catch (err) {
                console.error(`  ❌ DWG 掃描失敗 (${f.name}):`, err.message);
                errorCount++;
                _deepscanProgress.errorCount = errorCount;
            }

            // 每 BATCH_SIZE 個檔案清理一次 tg_cache，避免無限膨脹
            if (_deepscanProgress.current % BATCH_SIZE === 0) {
                try {
                    db.cleanupTgCache([...KEEP_PATHS]);
                } catch { /* 非必要 */ }
                console.log(`  ... ${_deepscanProgress.current}/${_deepscanProgress.total} ` +
                    `(${_deepscanProgress.mappingCount} mappings)`);
            }
        } // close for loop
    } catch (outerErr) {
        console.error('  ❌ Deep Scan 未預期錯誤:', outerErr.message);
        errorCount++;
        _deepscanProgress.errorCount = errorCount;
    }

    // 最終 tg_cache 清理
    try { db.cleanupTgCache([...KEEP_PATHS]); } catch { /* 非必要 */ }
    _deepscanProgress.phase = '寫入完成';

    const stats = db.getTgMappingStats();
    console.log(`  ✅ TG 映射完成: ${stats.total} 映射, ${stats.files} 個檔案, ${stats.drawing_numbers} 個圖號`);
    console.log(`     (掃描 ${scannedCount}, 快取 ${cachedCount}, 錯誤 ${errorCount})`);

    _deepscanProgress.running = false;
    _deepscanProgress.phase = '已完成';
    return { dwgCount: dwgFiles.length, totalMappings: batchAccum, scannedCount, cachedCount, errorCount };
}

// ========== Folder 預緩存（加速位置圖搜尋） ==========

/**
 * 建立/讀取 folder 預緩存
 * - 每個 folder 自包含單號，所有加工圖檔名就係圖號
 * - 掃描一次後永久快取喺 SQLite
 * @param {string} filePath - 所選檔案嘅完整路徑
 * @returns {string[]} 該 folder 所有加工圖嘅繪圖編號
 */
function _buildFolderCache(filePath) {
    const folder = path.dirname(filePath);
    const db = getDb();

    // 已有快取
    const cached = db.getFolderCache(folder);
    if (cached) {
        // 更新存取次數
        db.setFolderCache(folder, {
            drawing_numbers: cached.drawing_numbers,
            drawing_files: cached.drawing_files,
            tg_files: cached.tg_files,
            dwg_tg_files: cached.dwg_tg_files,
            pdf_tg_files: cached.pdf_tg_files,
        });
        return JSON.parse(cached.drawing_numbers || '[]');
    }

    // 建立新快取
    const drawingNumbers = new Set();
    const drawingFiles = [];
    const tgFiles = [];
    const dwgTgFiles = [];
    const pdfTgFiles = [];

    try {
        const entries = fs.readdirSync(folder);
        for (const f of entries) {
            const fullPath = path.join(folder, f);
            let stat;
            try { stat = fs.statSync(fullPath); } catch { continue; }
            if (!stat.isFile()) continue;

            const ext = path.extname(f).toLowerCase();
            if (/[-_](TG|TAG)/i.test(f)) {
                tgFiles.push(fullPath);
                if (ext === '.dwg') dwgTgFiles.push(fullPath);
                else if (ext === '.pdf') pdfTgFiles.push(fullPath);
            } else if (['.pdf', '.dwg', '.dxf'].includes(ext)) {
                const base = path.basename(f, ext);
                const nums = extractDrawingNumbers(base.toUpperCase());
                for (const n of nums) drawingNumbers.add(n);
                drawingFiles.push({ name: f, path: fullPath, ext });
            }
        }
    } catch (e) {
        console.error(`❌ 建立 folder 快取失敗 (${folder}):`, e.message);
    }

    const uniqueNumbers = [...drawingNumbers];

    db.setFolderCache(folder, {
        drawing_numbers: JSON.stringify(uniqueNumbers),
        drawing_files: JSON.stringify(drawingFiles),
        tg_files: JSON.stringify(tgFiles),
        dwg_tg_files: JSON.stringify(dwgTgFiles),
        pdf_tg_files: JSON.stringify(pdfTgFiles),
    });

    console.log(`📁 Folder 快取: ${path.basename(folder)} → ${uniqueNumbers.length} 圖號, ${tgFiles.length} 位置圖`);
    return uniqueNumbers;
}

/** 從 folder 取圖號（使用快取） */
function _getFolderDrawingNumbers(filePath) {
    return _buildFolderCache(filePath);
}

// ========== SessionManager Handler ==========

const MAX_RESULTS = 20;

function makeDrawingSearchHandler() {
    return {
        name: 'Drawing 圖紙搜尋',

        async start(ctx) {
            const index = loadIndex();
            if (!index.length) {
                return {
                    done: true,
                    result: '❌ 圖紙索引尚未建立。\n請管理員使用 `#searchpor` 建立索引。',
                };
            }
            ctx.index = index;
            ctx.step = 'input';
            return {
                question:
                    '📦 *圖紙搜尋*\n\n' +
                    `📂 索引中共有 *${index.length}* 個檔案\n\n` +
                    '請輸入圖紙編號（空格分隔）：\n' +
                    '例如：`ACA FAC 123`（項目+物料+編號）\n' +
                    '`WWA UN`（項目+物料）\n' +
                    '`FAC`（只物料）  `123`（只編號）\n\n' +
                    '輸入 `#cancel` 取消',
            };
        },

        async handleReply(ctx, replyMessage) {
            const rawInput = replyMessage.body.trim();
            const input = rawInput.toUpperCase();

            if (input === '#CANCEL') {
                return { done: true, result: '❌ *Drawing 搜尋已取消*' };
            }
            if (input === '#R') {
                return _goBack(ctx);
            }

            // ── 階段1：模糊輸入 ──
            if (ctx.step === 'input') {
                if (!rawInput) {
                    return { question: '❌ 請輸入圖紙編號（空格分隔條件）。\n輸入 `#cancel` 取消。' };
                }
                const results = searchDrawings(rawInput);
                if (results.length === 0) {
                    return { question: `❌ 找不到符合 "${rawInput}" 的圖紙。\n\n請重新輸入編號（#R 返回 / #cancel 取消）：` };
                }
                ctx.allResults = results;
                ctx.backStep = null;
                if (results.length > MAX_RESULTS) {
                    ctx.backStep = 'input';
                    return _askMaterialFilter(ctx, results);
                }
                ctx.backStep = 'input';
                return _showPdfSelection(ctx, results);
            }

            // ── 階段2：物料碼篩選 ──
            if (ctx.step === 'filter_material') {
                if (input === '0') {
                    ctx.backStep = 'filter_material';
                    return _showSystemOrPdf(ctx, ctx.allResults);
                }
                const idx = parseInt(input, 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= ctx.materialCodes.length) {
                    return { question: `❌ 請輸入 1-${ctx.materialCodes.length} 的數字，\`0\` 跳過篩選，\`#R\` 返回。` };
                }
                const [code] = ctx.materialCodes[idx];
                const filtered = ctx.allResults.filter(f => f.materials && f.materials.includes(code));
                ctx.filteredResults = filtered;
                ctx.backStep = 'filter_material';
                return _showSystemOrPdf(ctx, filtered);
            }

            // ── 階段3：系統碼篩選 ──
            if (ctx.step === 'filter_system') {
                if (input === '0') {
                    ctx.backStep = 'filter_system';
                    return _showPdfSelection(ctx, ctx.filteredResults);
                }
                const idx = parseInt(input, 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= ctx.systemCodes.length) {
                    return { question: `❌ 請輸入 1-${ctx.systemCodes.length} 的數字，\`0\` 跳過篩選，\`#R\` 返回。` };
                }
                const [sysCode] = ctx.systemCodes[idx];
                const filtered = ctx.filteredResults.filter(f =>
                    (f.systems && f.systems.includes(sysCode)) || f.system === sysCode
                );
                ctx.backStep = 'filter_system';
                return _showPdfSelection(ctx, filtered);
            }

            // ── 階段4：選擇 PDF 圖紙 ──
            if (ctx.step === 'select') {
                const pageMatch = input.match(/^P(\d+)$/);
                if (pageMatch) {
                    const targetPage = parseInt(pageMatch[1], 10);
                    const totalPages = Math.ceil(ctx.allPdfs.length / 10);
                    if (targetPage < 1 || targetPage > totalPages) {
                        return { question: `❌ 頁碼超出範圍（1-${totalPages}）。\n請輸入 \`p1\`-\`p${totalPages}\`，或 \`#R\` 返回。` };
                    }
                    return _showPdfSelection(ctx, ctx.allPdfs, targetPage);
                }

                const num = parseInt(input, 10);
                if (isNaN(num) || num < 1 || num > ctx.allPdfs.length) {
                    const extra = ctx.allPdfs.length > 10 ? `，\`p1\`-\`p${Math.ceil(ctx.allPdfs.length / 10)}\` 翻頁` : '';
                    return { question: `❌ 請輸入 1-${ctx.allPdfs.length} 的數字${extra}，或 \`#R\` 返回。` };
                }

                const pageSize = 10;
                const globalIndex = num - 1;
                const currentPage = ctx.currentPage || 1;
                const pageStart = (currentPage - 1) * pageSize;
                const localIndex = globalIndex - pageStart;
                if (localIndex < 0 || localIndex >= ctx.shownResults.length) {
                    return _showPdfSelection(ctx, ctx.allPdfs, Math.floor(globalIndex / pageSize) + 1);
                }
                const selected = ctx.shownResults[localIndex];
                ctx.selectedFile = selected.path;
                ctx.selectedName = selected.name;
                ctx.selectedPor = selected.por || '';
                ctx.selectedSystem = selected.system || '';
                ctx.selectedBase = path.basename(selected.name, path.extname(selected.name));

                const hasDwg = !!findMatchingFile(selected.path, '.dwg') || !!findMatchingFile(selected.path, '.DWG');
                const hasDxf = !hasDwg && (!!findMatchingFile(selected.path, '.dxf') || !!findMatchingFile(selected.path, '.DXF'));

                ctx.backStep = 'select';

                if (hasDwg || hasDxf) {
                    // 有名同 DWG/DXF → 格式選擇
                    ctx.step = 'select_format';
                    ctx.hasDwg = hasDwg;
                    ctx.hasDxf = hasDxf;
                    const ext = hasDwg ? 'DWG' : 'DXF';
                    return {
                        question:
                            `✅ 已選擇: *${selected.name}*\n` +
                            `🏢 POR: ${selected.por || '未知'}\n` +
                            (selected.system ? `🔧 系統: ${selected.system}\n` : '') +
                            `\n📎 發現同名 *.${ext.toLowerCase()}* 加工圖\n` +
                            '\n請選擇下載格式：\n' +
                            `1) PDF\n2) ${ext}\n3) 兩方（PDF + ${ext}）\n\n` +
                            '`#R` 返回 | `#cancel` 取消',
                    };
                }

                // 冇 DWG/DXF → 自動 folder 快取 + TG 掃描
                ctx.selectedFormats = ['pdf'];
                const drawingNumbers = _buildFolderCache(ctx.selectedFile);
                ctx.targetNumbers = drawingNumbers.length > 0 ? drawingNumbers : extractDrawingNumbers(ctx.selectedBase.toUpperCase());
                const tagFiles = resolveTgFiles(ctx.selectedFile);
                ctx.tagFiles = tagFiles;
                if (tagFiles.length > 0) {
                    try {
                        return await _scanAndShowRelevantTg(ctx);
                    } catch (scanErr) {
                        console.error('❌ TG 掃描失敗:', scanErr.message);
                        return _buildSendResult(ctx, []);
                    }
                }
                return _buildSendResult(ctx, []);
            }

            // ── 階段5：格式選擇（PDF/DWG/兩方） ──
            if (ctx.step === 'select_format') {
                const fmt = parseInt(input, 10);
                if (isNaN(fmt) || fmt < 1 || fmt > 3) {
                    return { question: '❌ 請輸入 1 (PDF)、2 (DWG/DXF) 或 3 (兩方)。\n`#R` 返回 | `#cancel` 取消' };
                }
                const extKey = ctx.hasDwg ? 'dwg' : 'dxf';
                const formatMap = { 1: ['pdf'], 2: [extKey], 3: ['pdf', extKey] };
                ctx.selectedFormats = formatMap[fmt];
                ctx.backStep = 'select_format';

                // Folder 快取 + TG 掃描
                const drawingNumbers = _buildFolderCache(ctx.selectedFile);
                ctx.targetNumbers = drawingNumbers.length > 0 ? drawingNumbers : extractDrawingNumbers(ctx.selectedBase.toUpperCase());
                const tagFiles = resolveTgFiles(ctx.selectedFile);
                ctx.tagFiles = tagFiles;
                if (tagFiles.length > 0) {
                    try {
                        return await _scanAndShowRelevantTg(ctx);
                    } catch (scanErr) {
                        console.error('❌ TG 掃描失敗:', scanErr.message);
                        return _buildSendResult(ctx, []);
                    }
                }
                return _buildSendResult(ctx, []);
            }

            // ── 階段6：TG 檔案選擇 ──
            if (ctx.step === 'select_tg') {
                if (input === 'V') return await _showTgDetail(ctx);
                return _handleTgSelection(ctx, input);
            }

            // ── 階段7：詳細 Section 對比 ──
            if (ctx.step === 'show_detail') {
                if (input === '#R') return _goBack(ctx);
                return { question: '輸入 `#R` 返回位置圖列表 | `#cancel` 取消' };
            }

            return { done: true, result: '❌ 未知步驟，搜尋已取消。' };
        },

        async onTimeout() {
            return '⏰ *Drawing 搜尋已超時*，請重新發起 `#Drawing`。';
        },

        async onCancel() {
            return '❌ *Drawing 搜尋已取消*';
        },
    };
}

// ── Helper: 系統碼篩選介面 ──
function _askSystemFilter(ctx, results) {
    ctx.step = 'filter_system';
    const systemCodes = extractSystemCodes(results);
    ctx.systemCodes = systemCodes;
    let question = `⚠️ 找到 *${results.length}* 個匹配結果（>${MAX_RESULTS}）\n\n*請選擇項目（系統碼）：*\n\n`;
    systemCodes.forEach(([code, count], i) => { question += `${i + 1}. ${code} — ${count} 個\n`; });
    question += '\n輸入 `0` 跳過篩選\n輸入 `#cancel` 取消';
    return { question };
}

// ── Helper: 物料碼篩選介面 ──
function _askMaterialFilter(ctx, results) {
    ctx.step = 'filter_material';
    ctx.filteredResults = results;
    const materialCodes = extractMaterialCodes(results);
    ctx.materialCodes = materialCodes;
    let question = `⚠️ 仍有 *${results.length}* 個結果（>${MAX_RESULTS}）\n\n*請選擇物料類型：*\n\n`;
    materialCodes.forEach(([code, count], i) => {
        const label = MATERIAL_CODES[code];
        question += `${i + 1}. ${code}${label ? ' ' + label : ''} — ${count} 個\n`;
    });
    question += '\n輸入 `0` 顯示全部\n輸入 `#cancel` 取消';
    return { question };
}

// ── Helper: 物料篩選後 → 系統碼篩選或直接 PDF ──
function _showSystemOrPdf(ctx, results) {
    const systemCodes = extractSystemCodes(results);
    if (results.length > MAX_RESULTS && systemCodes.length >= 2) return _askSystemFilter(ctx, results);
    return _showPdfSelection(ctx, results);
}

// ── Helper: 顯示 PDF 選擇列表 ──
function _showPdfSelection(ctx, results, page) {
    ctx.step = 'select';
    const pdfs = results.filter(f => f.name.toLowerCase().endsWith('.pdf'));
    ctx.allPdfs = pdfs;
    const pageSize = 10;
    const p = page || 1;
    const totalPages = Math.ceil(pdfs.length / pageSize);
    const start = (p - 1) * pageSize;
    const shown = pdfs.slice(start, start + pageSize);
    ctx.shownResults = shown;
    ctx.currentPage = p;

    let question = `🔍 找到 *${pdfs.length}* 個 PDF 圖紙`;
    if (results.length > pdfs.length) question += `（另有 ${results.length - pdfs.length} 個 DWG/DXF 未顯示）`;
    if (pdfs.length > pageSize) question += ` | 第 ${p}/${totalPages} 頁`;
    question += '：\n\n';
    shown.forEach((f, i) => {
        const num = start + i + 1;
        question += `${num}. *${f.name}*\n   🏢 ${f.por || '--'} | 🔧 ${f.system || '--'}\n`;
    });
    question += '\n請輸入數字選擇圖紙，或輸入';
    if (p > 1) question += ` \`p${p - 1}\` 上一頁`;
    if (p < totalPages) question += ` \`p${p + 1}\` 下一頁`;
    question += '\n輸入 `#cancel` 取消';
    return { question };
}

// ── #R 返回上一層 ──
function _goBack(ctx) {
    const back = ctx.backStep;
    if (!back || back === 'input') {
        ctx.step = 'input';
        ctx.backStep = null;
        const index = loadIndex();
        return {
            question:
                '📦 *圖紙搜尋*\n\n' +
                `📂 索引中共有 *${index.length}* 個檔案\n\n` +
                '請輸入圖紙編號（空格分隔）：\n' +
                '例如：`ACA FAC 123`（項目+物料+編號）\n' +
                '`WWA UN`（項目+物料）\n' +
                '`FAC`（只物料）  `123`（只編號）\n\n' +
                '輸入 `#cancel` 取消',
        };
    }

    ctx.step = back;

    if (back === 'filter_material') return _askMaterialFilter(ctx, ctx.allResults);
    if (back === 'filter_system') return _askSystemFilter(ctx, ctx.filteredResults);
    if (back === 'select') return _showPdfSelection(ctx, ctx.allPdfs, ctx.currentPage || 1);

    if (back === 'select_format') {
        const ext = ctx.hasDwg ? 'DWG' : 'DXF';
        return {
            question:
                `✅ 已選擇: *${ctx.selectedName}*\n` +
                `🏢 POR: ${ctx.selectedPor || '未知'}\n` +
                (ctx.selectedSystem ? `🔧 系統: ${ctx.selectedSystem}\n` : '') +
                `\n📎 發現同名 *.${ext.toLowerCase()}* 加工圖\n` +
                '\n請選擇下載格式：\n' +
                `1) PDF\n2) ${ext}\n3) 兩方（PDF + ${ext}）\n\n` +
                '`#R` 返回 | `#cancel` 取消',
        };
    }

    if (back === 'select_tg') {
        if (ctx.relevantTgFiles && ctx.relevantTgFiles.length > 0) return _showRelevantTgSelection(ctx);
        return _buildSendResult(ctx, []);
    }

    if (back === 'show_detail') {
        if (ctx.relevantTgFiles && ctx.relevantTgFiles.length > 0) return _showRelevantTgSelection(ctx);
        return _buildSendResult(ctx, []);
    }

    ctx.step = 'input';
    return { question: '❌ 無法返回，請重新輸入圖紙編號：' };
}

// ── 用 tg_mapping 索引查詢位置圖（取代即時 DWG 掃描） ──

/**
 * 用預建嘅 tg_mapping 索引查詢位置圖匹配
 * 唔再即時掃描 DWG，直接 SQL 查詢 tg_mapping 表
 *
 * @param {string[]} tagFiles - 該 folder 嘅位置圖檔案路徑
 * @param {string[]} targetNumbers - 目標繪圖編號
 * @returns {Array<{path, name, relevance, matchedNumbers, sourceMethod}>}
 */
function _queryTgFromIndex(tagFiles, targetNumbers) {
    const db = getDb();
    const uniqueTargets = [...new Set(
        targetNumbers.map(n => n.replace(/[-_]/g, '').toUpperCase())
    )];

    // 建立 tagFiles 嘅 lowercase 集合方便查詢
    const tagFileSet = new Set(tagFiles.map(f => f.toLowerCase()));

    // 記錄每個 tagFile 匹配到嘅圖號
    const fileMatches = {}; // tagFileLower → { numbers: [] }

    for (const num of uniqueTargets) {
        let rows;
        try {
            rows = db.getTgMappingByDrawingNumber(num);
        } catch {
            continue;
        }
        if (!rows || rows.length === 0) continue;

        for (const row of rows) {
            const dwgLower = row.file_path.toLowerCase();
            // 檢查被掃描嘅 DWG（或 companion PDF）係咪喺 tagFiles 入面
            let matchedFile = null;
            if (tagFileSet.has(dwgLower)) {
                matchedFile = row.file_path;
            } else {
                const pdfCompanion = row.file_path.replace(/\.dwg$/i, '.pdf');
                if (tagFileSet.has(pdfCompanion.toLowerCase())) {
                    matchedFile = pdfCompanion;
                }
            }

            if (matchedFile) {
                const key = matchedFile.toLowerCase();
                if (!fileMatches[key]) fileMatches[key] = { numbers: [] };
                if (!fileMatches[key].numbers.includes(num)) {
                    fileMatches[key].numbers.push(num);
                }
            }
        }
    }

    // 為所有 tagFiles 建立結果
    const results = [];
    for (const tf of tagFiles) {
        const key = tf.toLowerCase();
        const match = fileMatches[key];
        if (match && match.numbers.length > 0) {
            results.push({
                path: tf,
                name: path.basename(tf),
                relevance: 'exact',
                matchedNumbers: match.numbers.slice(0, 15),
                sourceMethod: 'index',
            });
        } else {
            results.push({
                path: tf,
                name: path.basename(tf),
                relevance: 'available',
                matchedNumbers: [],
                sourceMethod: 'index',
            });
        }
    }

    results.sort((a, b) => {
        const order = { exact: 0, available: 2 };
        return (order[a.relevance] || 9) - (order[b.relevance] || 9);
    });

    return results;
}

// ── 掃描 TG 並自動篩選相關位置圖（改用索引查詢） ──
async function _scanAndShowRelevantTg(ctx) {
    const tagFiles = ctx.tagFiles;

    if (!ctx.targetNumbers || ctx.targetNumbers.length === 0) {
        ctx.targetNumbers = _getFolderDrawingNumbers(ctx.selectedFile);
        if (ctx.targetNumbers.length === 0) {
            ctx.targetNumbers = extractDrawingNumbers(ctx.selectedBase.toUpperCase());
        }
    }
    const folderNumbers = ctx.targetNumbers;

    // 先只用所選嘅單一圖號做匹配，唔用成個 folder
    const specificNumbers = extractDrawingNumbers(ctx.selectedBase.toUpperCase());
    const useSpecific = specificNumbers.length > 0;
    const primaryNumbers = useSpecific ? specificNumbers : folderNumbers;

    // 改用 tg_mapping 索引查詢（毫秒級），唔再即時掃描 DWG
    let relevant = _queryTgFromIndex(tagFiles, primaryNumbers);
    let hasExact = relevant.some(r => r.relevance === 'exact');

    // 如果單一圖號匹配唔到，fallback 到 folder 層級
    if (!hasExact && useSpecific) {
        const fallback = _queryTgFromIndex(tagFiles, folderNumbers);
        if (fallback.some(r => r.relevance === 'exact')) {
            relevant = fallback;
            hasExact = true;
        }
    }

    ctx.relevantTgFiles = relevant;

    if (relevant.length === 0) {
        // 無任何匹配 → 列出全部位置圖
        ctx.relevantTgFiles = tagFiles.map(fp => ({
            path: fp, name: path.basename(fp), relevance: 'available', matchedNumbers: [],
        }));
        ctx.onlySuggested = true;
        const sel = _showRelevantTgSelection(ctx);
        sel.question = '⚠️ 位置圖索引無匹配（請先執行 `#searchpor` 重建 TG 映射）。\n\n' + sel.question;
        return sel;
    }

    ctx.onlySuggested = !hasExact;

    return _showRelevantTgSelection(ctx);
}

// ── TG 位置圖選擇介面 ──
function _showRelevantTgSelection(ctx) {
    ctx.step = 'select_tg';
    const relevant = ctx.relevantTgFiles;

    let question = '📍 *位置圖*';
    if (ctx.onlySuggested) question += '\n⚠️ 以下位置圖無精確匹配';
    question += '\n\n';
    let counter = 1;
    ctx.tgFileMap = [];

    for (const r of relevant) {
        ctx.tgFileMap.push({ num: counter, path: r.path, name: r.name });

        let sourceTag = '';
        if (r.sourceMethod === 'dwg_direct' || r.sourceMethod === 'companion_dwg') sourceTag = ' [DWG]';

        if (r.relevance === 'exact') {
            const numsStr = r.matchedNumbers.length > 0
                ? ' 📋 ' + r.matchedNumbers.slice(0, 3).map(fmtDrawingNumber).join(', ')
                : '';
            question += `${counter}. ✅ ${r.name}${sourceTag}${numsStr}\n`;
        } else {
            question += `${counter}. 📄 ${r.name}${sourceTag}\n`;
        }
        counter++;
    }

    question += '\n輸入數字選擇（逗號分隔，如 `1,3,5`）\n';
    question += '`v` 詳細對比（顯示繪圖編號）\n';
    question += '`0` 跳過 | `#R` 返回 | `#cancel` 取消';
    return { question };
}

/** 顯示 TG 詳細對比 */
async function _showTgDetail(ctx) {
    ctx.step = 'show_detail';
    ctx.backStep = 'select_tg';
    const tagFiles = ctx.tagFiles;
    const targetNumbers = ctx.targetNumbers || [];

    let question = '🔬 *詳細對比*\n\n';
    const detail = await scanTgSections(tagFiles, targetNumbers);

    for (const tg of detail) {
        question += `📄 *${tg.name}*\n`;
        question += `   全 TG 共 ${tg.totalNumbers} 個繪圖編號`;
        if (tg.matchedNumbers.length > 0) {
            question += `，匹配 ${tg.matchedNumbers.length} 個：${tg.matchedNumbers.map(fmtDrawingNumber).join(', ')}`;
        }
        question += '\n';
        if (tg.pageMatches.length > 0) {
            question += `   📑 匹配頁面：${tg.pageMatches.map(pm => `P${pm.pageNum}`).join('、')}\n`;
        }
        for (const p of tg.pages.slice(0, 5)) {
            if (p.numbers.length > 0) {
                const pageNums = p.numbers.slice(0, 10).map(fmtDrawingNumber).join(', ');
                question += `   P${p.pageNum}: ${pageNums}${p.numbers.length > 10 ? '…' : ''}\n`;
            }
        }
        if (tg.pages.length > 5) question += `   … 共 ${tg.pages.length} 頁\n`;
        question += '\n';
    }

    question += '`#R` 返回位置圖列表 | `#cancel` 取消';
    return { question };
}

// ── 處理 TG 選擇 ──
function _handleTgSelection(ctx, input) {
    if (input === '0') return _buildSendResult(ctx, []);

    const parts = input.split(/[,，\s]+/).filter(Boolean);
    const nums = [];
    for (const p of parts) {
        const n = parseInt(p, 10);
        if (isNaN(n)) {
            return { question: `❌ 無法識別 "${p}"。\n請輸入數字（逗號分隔，如 \`1,3,5\`），\`0\` 跳過，或 \`#R\` 返回。` };
        }
        nums.push(n);
    }

    if (nums.length === 0) {
        return { question: '❌ 請輸入數字（逗號分隔，如 `1,3,5`），`0` 跳過，或 `#R` 返回。' };
    }

    const selected = [];
    const invalidNums = [];
    for (const n of nums) {
        const entry = ctx.tgFileMap.find(e => e.num === n);
        if (entry) selected.push(entry.path);
        else invalidNums.push(n);
    }

    if (invalidNums.length > 0) {
        return { question: `❌ 編號 ${invalidNums.join(', ')} 無效。\n請輸入 1-${ctx.tgFileMap.length} 之間的數字，或 \`#R\` 返回。` };
    }

    if (selected.length === 0) {
        return { question: '❌ 未選擇任何檔案。\n請輸入數字（逗號分隔，如 `1,3,5`），`0` 跳過，或 `#R` 返回。' };
    }

    return _buildSendResult(ctx, selected);
}

// ── 構建最終發送結果 ──
function _buildSendResult(ctx, tgPaths) {
    const files = [];

    // 根據格式選擇加入對應檔案（唔再硬塞 PDF）
    if (ctx.selectedFormats) {
        if (ctx.selectedFormats.includes('pdf')) {
            files.push({ path: ctx.selectedFile, name: ctx.selectedName });
        }
        if (ctx.selectedFormats.includes('dwg')) {
            const dwgPath = findMatchingFile(ctx.selectedFile, '.dwg') || findMatchingFile(ctx.selectedFile, '.DWG');
            if (dwgPath) files.push({ path: dwgPath, name: path.basename(dwgPath) });
        }
        if (ctx.selectedFormats.includes('dxf')) {
            const dxfPath = findMatchingFile(ctx.selectedFile, '.dxf') || findMatchingFile(ctx.selectedFile, '.DXF');
            if (dxfPath) files.push({ path: dxfPath, name: path.basename(dxfPath) });
        }
    } else {
        // 冇格式選擇（冇 companion），預設只 send PDF
        files.push({ path: ctx.selectedFile, name: ctx.selectedName });
    }

    // 分辨哪些 TG 係精確匹配
    const tgSet = new Set(Array.isArray(tgPaths) ? tgPaths : []);
    const exactSet = new Set();
    if (ctx.relevantTgFiles) {
        for (const r of ctx.relevantTgFiles) {
            if (r.relevance === 'exact' && tgSet.has(r.path)) exactSet.add(r.path);
        }
    }

    // 結果文字同附件都要排列：匹配 TG 優先
    const resultLines = [];
    const attachmentPaths = [];

    // 整理每個 TG 檔案嘅顯示名稱（只加用家實際揀咗嘅格式）
    for (const tp of tgSet) {
        const isExact = exactSet.has(tp);
        const matchedR = isExact ? ctx.relevantTgFiles.find(r => r.path === tp) : null;
        const icon = isExact ? '✅' : '📄';
        const ext = path.extname(tp).toUpperCase();

        let line = `${icon} *${path.basename(tp)}*`;
        if (matchedR && matchedR.matchedNumbers.length > 0) {
            line += ` 📋 ${matchedR.matchedNumbers.map(fmtDrawingNumber).join(', ')}`;
        }
        resultLines.push(line);
        attachmentPaths.push(tp);
    }

    // 組合結果文字
    let result = '📄 *圖紙發送中...*\n';
    if (ctx.selectedPor) result += `🏢 POR: ${ctx.selectedPor}\n`;
    if (resultLines.length > 0) result += '\n' + resultLines.join('\n') + '\n';

    // 完整附件清單（選取加工圖 + 佢嘅 companion + TG file）
    const allFiles = [...files];
    for (const ap of attachmentPaths) {
        if (!allFiles.some(f => f.path === ap)) {
            allFiles.push({ path: ap, name: path.basename(ap) });
        }
    }
    result += '\n';
    allFiles.forEach((f, i) => { result += `${i + 1}. ${f.name}\n`; });

    return {
        done: true,
        result,
        attachments: allFiles.map(f => f.path),
        attachmentCaption: allFiles.map(f => f.name).join(' + '),
        completionMessage: '✅ 已完成所有發送',
    };
}

// ========== 自動重建（給 scheduler 用） ==========

async function autoRebuildTask(porPath, _client) {
    return await buildIndex(porPath);
}

// ========== DWG 反向查詢：加工圖號 → 位置圖 ==========

/**
 * 從 index 搵出指定加工圖號對應嘅位置圖
 */
function findLayoutByFabNumber(drawingNumber) {
    const index = loadIndex();
    const clean = drawingNumber.replace(/[-_]/g, '').toUpperCase();

    for (const f of index) {
        const name = f.name.toUpperCase();
        if (name.includes(clean) || clean.includes(name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ''))) {
            const tgFiles = getTagFiles(f.path);
            if (tgFiles.length > 0) {
                return { found: true, drawingNumber: clean, layoutFiles: tgFiles, source: 'filename' };
            }
        }
    }
    return { found: false, drawingNumber: clean, layoutFiles: [], source: null };
}

/**
 * 掃描 TG 位置圖 DWG，提取其中所有加工圖號
 */
async function scanLayoutDwg(tgPath) {
    if (!isDwgReaderAvailable()) {
        return { numbers: [], texts: [], error: 'DWG 解析器未初始化' };
    }
    const ext = path.extname(tgPath).toLowerCase();
    let dwgPath = tgPath;
    if (ext === '.pdf') {
        const dwg = tgPath.replace(/\.pdf$/i, '.dwg').replace(/\.PDF$/, '.DWG');
        if (fs.existsSync(dwg)) {
            dwgPath = dwg;
        } else {
            return { numbers: [], texts: [], error: '找不到對應嘅 DWG 檔' };
        }
    }
    try {
        const texts = await extractTextArrayFromDwg(dwgPath);
        const allText = texts.join(' ');
        const numbers = extractDrawingNumbers(allText.toUpperCase());
        return { numbers, texts, dwgPath };
    } catch (err) {
        return { numbers: [], texts: [], error: err.message };
    }
}

/**
 * SessionManager handler: #dwgfind — 輸入加工圖號找位置圖
 */
function makeDwgFindHandler() {
    return {
        name: 'DWG 加工圖→位置圖',

        async start(ctx) {
            const available = isDwgReaderAvailable();
            let question = '🔍 *加工圖號 → 位置圖*\n\n';
            question += '請輸入加工圖號：\n';
            question += '例如：`ACB-ACD-0064`、`ACD0060`\n\n';
            if (!available) {
                question += '⚠️ *注意：* DWG 解析器未初始化，將使用檔名匹配（準確度較低）。\n';
            }
            question += '輸入 `#cancel` 取消';
            return { question };
        },

        async handleReply(ctx, replyMessage) {
            const input = replyMessage.body.trim().toUpperCase();
            if (input === '#CANCEL') return { done: true, result: '❌ *查詢已取消*' };
            if (!input) return { question: '❌ 請輸入加工圖號。\n輸入 `#cancel` 取消。' };

            const result = findLayoutByFabNumber(input);
            if (!result.found) {
                return {
                    question:
                        `❌ 找不到加工圖號 *${input}* 對應嘅位置圖。\n\n` +
                        '可能原因：\n• 圖號不在 POR 目錄中\n• 請檢查圖號是否正確\n\n' +
                        '請重新輸入，或 `#cancel` 取消。',
                };
            }

            const tgFiles = result.layoutFiles;
            ctx.tgFiles = tgFiles;

            // 掃描每張位置圖 DWG，提取入面嘅繪圖編號
            let msg = `✅ *${fmtDrawingNumber(result.drawingNumber)}* 對應嘅位置圖：\n\n`;
            let hasDwgContent = false;
            for (let i = 0; i < tgFiles.length; i++) {
                const name = path.basename(tgFiles[i]);
                const scan = await scanLayoutDwg(tgFiles[i]);
                const nums = scan.numbers || [];
                const uniqueNums = [...new Set(nums.map(n => fmtDrawingNumber(n)))];
                msg += `${i + 1}. 📄 ${name}`;
                if (uniqueNums.length > 0) {
                    hasDwgContent = true;
                    msg += `\n   📋 ${uniqueNums.slice(0, 5).join(', ')}`;
                    if (uniqueNums.length > 5) msg += ` 等 ${uniqueNums.length} 個圖號`;
                } else if (scan.error) {
                    msg += `\n   ⚠️ ${scan.error}`;
                }
                msg += '\n';
            }
            if (hasDwgContent) msg += `\n來源：DWG 內容提取`;
            else msg += `\n來源：檔名匹配`;
            msg += `\n\n💡 可用 \`#dwgfind\` 重新查詢其他圖號`;

            ctx.foundResult = result;
            if (tgFiles.length > 0) {
                ctx.step = 'ask_send';
                ctx.tgFiles = tgFiles;
                msg += '\n\n需要發送位置圖嗎？\n回覆 `y` 或 `n`';
                return { question: msg };
            }
            return { done: true, result: msg };
        },

        async onTimeout() {
            return '⏰ *查詢已超時*，請重新 `#dwgfind`。';
        },

        async onCancel() {
            return '❌ *查詢已取消*';
        },
    };
}

// ── Helper: 處理發送確認 ──
async function _handleDwgFindSend(ctx, replyMessage) {
    const input = replyMessage.body.trim().toUpperCase();
    if (input === '#CANCEL') return { done: true, result: '❌ *已取消*' };
    const isYes = ['Y', 'YES', '是', '確認', 'OK'].includes(input);
    const isNo = ['N', 'NO'].includes(input);
    if (!isYes && !isNo) return { question: '❌ 請輸入 `y`（是）或 `n`（否）。' };
    if (isNo || ctx.tgFiles.length === 0) return { done: true, result: '✅ *查詢完成*' };
    const files = ctx.tgFiles.map(fp => ({ path: fp, name: path.basename(fp) }));
    return {
        done: true,
        result: `📄 *發送 ${files.length} 個位置圖檔案...*`,
        attachments: files.map(f => f.path),
        attachmentCaption: files.map(f => f.name).join(' + '),
    };
}

// 擴充 makeDwgFindHandler 支援 ask_send 階段
const _origMakeDwgFindHandler = makeDwgFindHandler;
makeDwgFindHandler = function () {
    const handler = _origMakeDwgFindHandler();
    const origHandleReply = handler.handleReply;
    handler.handleReply = async function (ctx, replyMessage) {
        if (ctx.step === 'ask_send') return _handleDwgFindSend(ctx, replyMessage);
        return origHandleReply.call(this, ctx, replyMessage);
    };
    return handler;
};

// ========== 增量更新 TG 映射（單一資料夾層級） ==========

/**
 * 增量更新：只掃描指定資料夾內嘅 DWG 位置圖
 * 用於 `#searchpor` 以外嘅情境，減少全量掃描負擔
 *
 * @param {string} folderPath - 要重新掃描嘅資料夾路徑
 * @returns {Promise<{updatedCount: number, totalMappings: number}>}
 */
async function incrementalTgUpdate(folderPath) {
    if (!isDwgReaderAvailable()) {
        console.warn('  ⚠️ DWG Reader 不可用，跳過增量更新');
        return { updatedCount: 0, totalMappings: 0 };
    }

    if (!fs.existsSync(folderPath)) {
        console.warn(`  ⚠️ 資料夾唔存在: ${folderPath}`);
        return { updatedCount: 0, totalMappings: 0 };
    }

    const db = getDb();
    let updatedCount = 0;
    const mappingsToUpdate = [];
    const deletePaths = [];

    // 掃描資料夾，找出 DWG 位置圖
    const entries = fs.readdirSync(folderPath);
    for (const entry of entries) {
        const fullPath = path.join(folderPath, entry);
        let stat;
        try { stat = fs.statSync(fullPath); } catch { continue; }
        if (!stat.isFile()) continue;
        const ext = path.extname(entry).toLowerCase();
        if (ext !== '.dwg') continue;
        if (!/[-_](TG|TAG)/i.test(entry) && !/位置图/i.test(entry) && !/位置圖/i.test(entry)) continue;

        try {
            const cached = db.getTgCache(fullPath);
            const isFresh = cached &&
                cached.drawing_numbers &&
                cached.drawing_numbers !== '[]' &&
                Math.abs(Number(cached.mtime) - stat.mtimeMs) < 1;

            let numbers = [];
            if (isFresh) {
                numbers = JSON.parse(cached.drawing_numbers);
            } else {
                const texts = await extractTextArrayFromDwg(fullPath, 60000);
                const allText = texts.join(' ');
                numbers = extractDrawingNumbers(allText.toUpperCase());
                db.setTgCache(fullPath, {
                    drawing_numbers: JSON.stringify(numbers),
                    source_method: 'dwg_direct',
                    mtime: stat.mtimeMs,
                });
            }

            const now = new Date().toISOString();
            deletePaths.push(fullPath);
            for (const num of numbers) {
                mappingsToUpdate.push({
                    drawing_number: num,
                    file_path: fullPath,
                    dwg_path: fullPath,
                    updated_at: now,
                });
            }

            // 也處理 companion PDF
            const pdfPath = fullPath.replace(/\.dwg$/i, '.pdf').replace(/\.DWG$/, '.PDF');
            if (fs.existsSync(pdfPath)) {
                deletePaths.push(pdfPath);
                for (const num of numbers) {
                    mappingsToUpdate.push({
                        drawing_number: num,
                        file_path: pdfPath,
                        dwg_path: fullPath,
                        updated_at: now,
                    });
                }
            }

            updatedCount++;
        } catch (err) {
            console.error(`  ❌ 增量更新失敗 (${entry}):`, err.message);
        }
    }

    // Transaction 保護：所有 delete + insert 原子操作
    if (mappingsToUpdate.length > 0) {
        if (deletePaths.length > 0) {
            const tx = db.db.transaction(() => {
                for (const p of deletePaths) {
                    db.deleteTgMappingByFilePath(p);
                }
                db.insertTgMapping(mappingsToUpdate);
            });
            try { tx(); } catch (e) {
                console.error('  ❌ 增量更新 transaction 失敗:', e.message);
                return { updatedCount: 0, totalMappings: 0 };
            }
        } else {
            db.insertTgMapping(mappingsToUpdate);
        }
    }

    console.log(`  ✅ 增量更新完成: ${updatedCount} 個檔案, ${mappingsToUpdate.length} 條映射`);
    return { updatedCount, totalMappings: mappingsToUpdate.length };
}

/**
 * 檢測指定資料夾嘅 DWG 檔案有無變更，必要時自動觸發增量更新
 * 用於 `#searchpor` 以外嘅時間點
 *
 * @param {string} folderPath - 目標資料夾
 * @returns {Promise<boolean>} 是否有更新
 */
async function checkAndUpdateTgFolder(folderPath) {
    if (!fs.existsSync(folderPath)) return false;
    const db = getDb();
    let needsUpdate = false;

    try {
        const entries = fs.readdirSync(folderPath);
        for (const entry of entries) {
            const fullPath = path.join(folderPath, entry);
            let stat;
            try { stat = fs.statSync(fullPath); } catch { continue; }
            if (!stat.isFile()) continue;
            const ext = path.extname(entry).toLowerCase();
            if (ext !== '.dwg') continue;

            const cached = db.getTgCache(fullPath);
            if (!cached || Math.abs(Number(cached.mtime) - stat.mtimeMs) >= 1) {
                needsUpdate = true;
                break;
            }
        }
    } catch { return false; }

    if (needsUpdate) {
        await incrementalTgUpdate(folderPath);
        return true;
    }
    return false;
}

// ========== 匯出 ==========

module.exports = {
    buildIndex,
    loadIndex,
    searchDrawings,
    getTagFile,
    getTagFiles,
    makeDrawingSearchHandler,
    autoRebuildTask,
    extractDrawingNumbers,
    scanTgFilesForDrawing,
    scanTgSections,
    getTgCacheStats,
    get indexLoaded() { return _indexLoaded; },
    findLayoutByFabNumber,
    scanLayoutDwg,
    makeDwgFindHandler,
    isDwgReaderAvailable,
    get cachedCount() { return _cachedIndex ? _cachedIndex.length : 0; },
    // 新匯出：TG 映射相關
    rebuildTgMapping: _rebuildTgMapping,
    incrementalTgUpdate,
    checkAndUpdateTgFolder,
    queryTgFromIndex: _queryTgFromIndex,
    deepscanProgress: _deepscanProgress,
};
