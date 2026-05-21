/**
 * 物料圖紙搜尋模組 (Drawing Search)
 *
 * 預建索引策略：
 * - 掃描 POR 目錄一次，建立 drawing_index.json
 * - Bot 永遠只查索引檔，不實時掃描檔案系統
 * - 凌晨 3:00 AM 自動重建，或管理員手動 #searchpor
 */

const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
const { dataStore } = require('../src/core/dataStore');
const Tesseract = require('tesseract.js');
const ExcelJS = require('exceljs');
const { extractTextArrayFromDwg, isDwgReaderAvailable } = require('../tools/dwgReader');

// 索引檔路徑
const INDEX_FILE = path.join(
    __dirname,
    '..',
    'data',
    'store',
    'drawing_index.json'
);

// TG 內容快取（data/store/app.json 中的 key）
const TG_CACHE_KEY = 'tg_content_cache';

// 繪圖編號正則：2-4 大寫字母 + 可選分隔符 + 可選字母前綴 + 3-6 位數字
// e.g. ACD-0301, FAC6553, ACD-A501 (字母前綴 + 數字)
const DRAWING_NUMBER_RE = /[A-Z]{2,4}[-_]?(?:[A-Z])?\d{3,6}/g;

// TG 排除詞（用於從檔名提取系統碼時排除）
const TG_EXCLUDE = new Set([
    'TG',
    'TAG',
    'RF',
    'FOR',
    'AND',
    'THE',
    'NEW',
    'OLD',
    'POR',
    'ISO',
    'DWG',
    'PDF',
    'DXF',
    'JPG',
    'PNG',
    'TIFF',
    'TIF',
]);

// 常駐記憶體快取
let _cachedIndex = null;
let _indexLoaded = false;
let _tgAcdMap = null; // ACD 編號 → TG 檔案路徑對照表

// 物料碼分類
const MATERIAL_CODES = {
    FST: '鐵料',
    FAC: '鋁板',
    BOM: '雜件/型材',
    BBF: '螺絲',
    FFA: '防水片/收口角',
    BGK: '墊塊',
    FHU: '加工組裝件',
    BGL: '玻璃',
    FHA: '鋁料加工件',
    FSS: '不鏽鋼',
    HGRH: '鋁型材',
    ACD: '鋁板',
    UN: '單元',
    AP: '防水片',
    JMA: '鋁角',
    MSB: '鐵角',
    MSA: '鐵碼',
    MSH: '鐵Hollow',
};

// ========== 索引建立 ==========

/**
 * 遞迴掃描目錄，建立索引
 * @returns {Array} 索引陣列
 */
function scanDirectory(dirPath) {
    const results = [];
    if (!fs.existsSync(dirPath)) return results;

    // 排除的非系統碼（TG, 數字開頭, 單字母, 常見詞等）
    const EXCLUDE_SYSTEMS = new Set([
        'TG',
        'TAG',
        'RF',
        'FOR',
        'AND',
        'THE',
        'NEW',
        'OLD',
        'POR',
        'ISO',
        'ASS',
        'DWG',
        'PDF',
        'DXF',
        'JPG',
        'PNG',
        'TIFF',
        'TIF',
    ]);

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                results.push(...scanDirectory(fullPath));
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (
                    [
                        '.pdf',
                        '.dwg',
                        '.dxf',
                        '.jpg',
                        '.png',
                        '.tiff',
                        '.tif',
                    ].includes(ext)
                ) {
                    const name = entry.name;
                    const upperName = name.toUpperCase();

                    // ── 提取所有有效碼（用 - _ 分隔的 2-4 大寫字母 token） ──
                    const allCodes = [];
                    const tokens = upperName
                        .replace(/\.[^.]+$/, '')
                        .split(/[-_]+/);
                    for (const token of tokens) {
                        const clean = token.replace(/\d.*$/, ''); // 去掉尾部數字 (如 WCA0606 → WCA)
                        if (
                            /^[A-Z]{2,4}$/.test(clean) &&
                            !EXCLUDE_SYSTEMS.has(clean)
                        ) {
                            if (!allCodes.includes(clean)) allCodes.push(clean);
                        }
                        // 字母-數字交界 (如 WCA0606 → WCA)
                        const codeMatch = token.match(/^([A-Z]{2,4})\d/);
                        if (
                            codeMatch &&
                            !EXCLUDE_SYSTEMS.has(codeMatch[1]) &&
                            !allCodes.includes(codeMatch[1])
                        ) {
                            allCodes.push(codeMatch[1]);
                        }
                    }

                    // ── 找出項目碼：如果第一個是 HGRH 則跳過，取第二個為項目 ──
                    let projectIdx = 0;
                    if (allCodes.length > 1 && allCodes[0] === 'HGRH') {
                        projectIdx = 1;
                    }
                    const primarySystem =
                        allCodes.length > projectIdx
                            ? allCodes[projectIdx]
                            : '';
                    const systems = primarySystem ? [primarySystem] : [];
                    // 項目之前的碼（如 HGRH）也歸入物料
                    const beforeProject = allCodes
                        .slice(0, projectIdx)
                        .filter((c) => !EXCLUDE_SYSTEMS.has(c));
                    // 項目之後的碼 = 物料
                    const afterProject = allCodes
                        .slice(projectIdx + 1)
                        .filter((c) => !EXCLUDE_SYSTEMS.has(c));
                    const materials = [...beforeProject, ...afterProject];

                    // first system is the primary (first token that looks like a system code)
                    const system = systems.length > 0 ? systems[0] : '';

                    // ── POR 子目錄（跳過主目錄 01 POR ISAAC，取下一層） ──
                    const porMatch = fullPath.match(
                        /POR[/\\][^/\\]+[/\\]([^/\\]+)/i
                    );
                    const por = porMatch ? porMatch[1] : '';

                    // ── TG 檢測 ──
                    let hasTag = false;
                    if (
                        name.includes('_TG') ||
                        name.includes('-TG') ||
                        upperName.includes('TAG')
                    ) {
                        hasTag = true;
                    } else {
                        try {
                            const dirEntries = fs.readdirSync(dirPath);
                            const base = path.basename(name, ext);
                            hasTag = dirEntries.some(
                                (f) =>
                                    f !== name &&
                                    (f.includes('_TG') ||
                                        f.includes('-TG') ||
                                        f.toUpperCase().includes('TAG')) &&
                                    (f.includes(base) ||
                                        base.includes(
                                            f
                                                .replace(/[-_]TG.*$/i, '')
                                                .replace(/\.[^.]+$/, '')
                                        ))
                            );
                        } catch {
                            /* ignore */
                        }
                    }

                    results.push({
                        name,
                        path: fullPath,
                        system,
                        systems,
                        por,
                        materials,
                        hasTag,
                    });
                }
            }
        }
    } catch (e) {
        console.error(`❌ 掃描目錄失敗 (${dirPath}):`, e.message);
    }
    return results;
}

/**
 * 建立索引並寫入 JSON 檔案
 */
async function buildIndex(porPath) {
    console.log(`🔍 開始建立圖紙索引: ${porPath}`);
    const start = Date.now();

    const index = scanDirectory(porPath);

    // 建立 TG-ACD 對照表（從 Excel 提料單 + DWG 檔名）
    const tgAcdMap = await buildTgAcdMap(porPath);
    const mapSize = Object.keys(tgAcdMap).length;

    // 寫入索引檔
    const data = {
        lastBuild: new Date().toISOString(),
        porPath,
        fileCount: index.length,
        files: index,
        tgAcdMap,
    };
    fs.writeFileSync(INDEX_FILE, JSON.stringify(data, null, 2), 'utf8');

    // 更新記憶體快取
    _cachedIndex = index;
    _indexLoaded = true;
    _tgAcdMap = tgAcdMap;

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
        `✅ 索引建立完成: ${index.length} 個檔案, ${mapSize} 個 ACD→TG 對照, 耗時 ${elapsed}s`
    );
    return { fileCount: index.length, elapsed };
}

/**
 * 掃描 POR 目錄，從 Excel 提料單 + DWG 檔名建立 ACD→TG 對照表
 *
 * 逐個子目錄檢查：
 * 1. 有 TG 檔 = 該目錄係一個項目套件
 * 2. 讀 Excel 提料單 → 提取 ACD 編號
 * 3. 掃描 DWG 檔名 → 補充 ACD 編號
 * 4. 每個 ACD 編號 → 該目錄所有 TG 檔
 *
 * 呢個方法比 OCR 更準確，因為 Excel 提料單係官方物料清單
 */
async function buildTgAcdMap(porPath) {
    const map = {}; // ACD 編號 (無分隔符) → [TG 檔案路徑]
    const tgDirs = {}; // 目錄 → { tgFiles: [], xlsxFiles: [] }

    // Step 1: 掃描所有子目錄，找出有 TG 檔嘅目錄
    function scanTgDirs(dir) {
        if (!fs.existsSync(dir)) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            const files = entries.filter((e) => e.isFile()).map((e) => e.name);
            const dirs = entries.filter((e) => e.isDirectory());

            // 檢查呢個目錄有冇 TG 檔
            const tgFiles = files
                .filter(
                    (f) =>
                        !f.toUpperCase().endsWith('.DWL') &&
                        !f.toUpperCase().endsWith('.DWL') &&
                        (f.toUpperCase().includes('-TG-') ||
                            f.toUpperCase().includes('_TG_'))
                )
                .map((f) => path.join(dir, f));
            const xlsxFiles = files
                .filter(
                    (f) =>
                        !f.startsWith('~$') &&
                        f.toLowerCase().endsWith('.xlsx')
                )
                .map((f) => path.join(dir, f));

            if (tgFiles.length > 0) {
                tgDirs[dir] = { tgFiles, xlsxFiles };
            }

            // 遞迴子目錄
            for (const d of dirs) {
                scanTgDirs(path.join(dir, d.name));
            }
        } catch (e) {
            /* 權限錯誤跳過 */
        }
    }

    scanTgDirs(porPath);

    const dirCount = Object.keys(tgDirs).length;
    console.log(`📂 掃描到 ${dirCount} 個含有 TG 檔嘅目錄`);

    // Step 2: 對每個目錄，從 DWG 檔名 + Excel 提取 ACD 編號
    let xlsxCount = 0;
    for (const [dir, info] of Object.entries(tgDirs)) {
        const { tgFiles, xlsxFiles } = info;

        // 2a: 從 DWG 檔名提取 ACD 編號（同步、可靠）
        try {
            const allFiles = fs.readdirSync(dir);
            const dwgFiles = allFiles.filter((f) =>
                f.toUpperCase().endsWith('.DWG')
            );
            for (const dwg of dwgFiles) {
                const numbers = extractDrawingNumbers(dwg.toUpperCase());
                for (const num of numbers) {
                    const clean = num.replace(/[-_]/g, '').toUpperCase();
                    if (
                        clean.startsWith('ACD') ||
                        clean.startsWith('AFBACD')
                    ) {
                        if (!map[clean]) map[clean] = new Set();
                        for (const tg of tgFiles) map[clean].add(tg);
                    }
                }
            }
        } catch (e) {
            /* 忽略 */
        }

        // 2a2: 從 DWG 內容提取繪圖編號（精度 100%，不需 OCR）
        if (isDwgReaderAvailable()) {
            try {
                const allFiles = fs.readdirSync(dir);
                const dwgFiles = allFiles.filter((f) =>
                    f.toUpperCase().endsWith('.DWG')
                );
                for (const dwg of dwgFiles) {
                    try {
                        const dwgPath = path.join(dir, dwg);
                        const texts = await extractTextArrayFromDwg(dwgPath);
                        const allText = texts.join(' ');
                        const numbers = extractDrawingNumbers(allText.toUpperCase());
                        for (const num of numbers) {
                            const clean = num.replace(/[-_]/g, '').toUpperCase();
                            if (clean.length >= 6) {
                                if (!map[clean]) map[clean] = new Set();
                                for (const tg of tgFiles) map[clean].add(tg);
                            }
                        }
                    } catch (dwgErr) {
                        // 個別 DWG 讀取失敗，繼續下一個
                    }
                }
            } catch (e) {
                /* 忽略 */
            }
        }

        // 2b: 從 Excel 提料單提取 ACD 編號（非同步、完整）
        for (const xlsxPath of xlsxFiles) {
            try {
                const wb = new ExcelJS.Workbook();
                await wb.xlsx.readFile(xlsxPath);
                for (const ws of wb.worksheets) {
                    ws.eachRow(
                        { includeEmpty: false },
                        /**
                         * @param {import('exceljs').Row} row
                         */
                        (row) => {
                            for (let c = 1; c <= row.cellCount; c++) {
                                const cell = row.getCell(c).value;
                                if (
                                    cell &&
                                    typeof cell === 'string' &&
                                    cell.toUpperCase().includes('ACD')
                                ) {
                                    const numbers =
                                        extractDrawingNumbers(
                                            cell.toUpperCase()
                                        );
                                    for (const num of numbers) {
                                        const clean = num
                                            .replace(/[-_]/g, '')
                                            .toUpperCase();
                                        if (
                                            clean.startsWith('ACD') ||
                                            clean.startsWith('AFBACD')
                                        ) {
                                            if (!map[clean])
                                                map[clean] = new Set();
                                            for (const tg of tgFiles)
                                                map[clean].add(tg);
                                        }
                                    }
                                }
                            }
                        }
                    );
                }
                xlsxCount++;
            } catch (e) {
                console.error(
                    `❌ 讀取 Excel 失敗 (${path.basename(xlsxPath)}):`,
                    e.message
                );
            }
        }
    }

    // 將 Set 轉為 Array（JSON 序列化用）
    const result = {};
    for (const [k, v] of Object.entries(map)) {
        result[k] = [...v];
    }

    console.log(
        `📊 TG-ACD 對照表建立完成: ${xlsxCount} 個 Excel, ${Object.keys(result).length} 個 ACD 編號`
    );
    return result;
}

/** 載入索引到記憶體 */
function loadIndex() {
    if (_indexLoaded && _cachedIndex) return _cachedIndex;
    try {
        if (fs.existsSync(INDEX_FILE)) {
            const raw = fs.readFileSync(INDEX_FILE, 'utf8');
            const data = JSON.parse(raw);
            _cachedIndex = data.files || [];
            _tgAcdMap = data.tgAcdMap || null;
            _indexLoaded = true;
            const mapSize = _tgAcdMap ? Object.keys(_tgAcdMap).length : 0;
            console.log(
                `📂 圖紙索引已載入: ${_cachedIndex.length} 個檔案, ${mapSize} 個 ACD→TG 對照`
            );
            return _cachedIndex;
        }
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
    const matCodes = []; // 已知物料碼 → 只過濾 materials
    const generalCodes = []; // 2-4 字母非物料碼 → 同時過濾 system + materials + 檔名
    const keywords = []; // 其他 → 只過濾檔名

    for (const t of tokens) {
        if (MATERIAL_CODES[t]) {
            matCodes.push(t);
        } else if (/^[A-Z]{2,4}$/.test(t)) {
            generalCodes.push(t);
        } else {
            // 嘗試從 token 開頭拆出物料碼（如 ACD-0212 → ACD + 0212，ACD0212 → ACD + 0212）
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

    return index.filter((f) => {
        const name = f.name.toUpperCase();
        for (const kw of keywords) {
            if (!name.includes(kw)) return false;
        }
        for (const mc of matCodes) {
            if (!f.materials || !f.materials.includes(mc)) return false;
        }
        for (const gc of generalCodes) {
            // 通用碼：system、materials、檔名 任何一個符合就得
            const matchSys = f.system === gc;
            const matchMat = f.materials && f.materials.includes(gc);
            const matchName = name.includes(gc);
            if (!matchSys && !matchMat && !matchName) return false;
        }
        return true;
    });
}

/** 從結果中提取出現的物料碼及其數量（使用索引中預提取的 materials 欄位） */
function extractMaterialCodes(results) {
    const codes = {};
    for (const f of results) {
        if (f.materials && f.materials.length) {
            for (const code of f.materials) {
                codes[code] = (codes[code] || 0) + 1;
            }
        }
    }
    const sorted = Object.entries(codes).sort((a, b) => b[1] - a[1]);
    return sorted;
}

/** 從結果中提取出現的系統碼及其數量（使用索引中預提取的 systems 欄位） */
function extractSystemCodes(results) {
    const codes = {};
    for (const f of results) {
        const src =
            f.systems && f.systems.length
                ? f.systems
                : f.system
                  ? [f.system]
                  : [];
        for (const s of src) {
            codes[s] = (codes[s] || 0) + 1;
        }
    }
    const sorted = Object.entries(codes).sort((a, b) => b[1] - a[1]);
    return sorted;
}

/** 取得同目錄的 TG 檔案 */
/** 取得同目錄所有 TG 檔案 */
function getTagFiles(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const results = [];
    try {
        const entries = fs.readdirSync(dir);
        for (const f of entries) {
            const upper = f.toUpperCase();
            const baseUpper = base.toUpperCase();
            if (
                f !== path.basename(filePath) &&
                !f.toUpperCase().endsWith('.DWL') &&
                (upper.includes('_TG') ||
                    upper.includes('-TG') ||
                    upper.includes('TAG')) &&
                (upper.includes(baseUpper) ||
                    baseUpper.includes(
                        f.replace(/[-_]TG.*$/i, '').replace(/\.[^.]+$/, '')
                    ))
            ) {
                results.push(path.join(dir, f));
            }
        }
    } catch {
        /* ignore */
    }
    return results;
}

function getTagFile(filePath) {
    const files = getTagFiles(filePath);
    return files.length > 0 ? files[0] : null;
}

/**
 * 合併 lookup：同目錄檔名匹配 + ACD→TG 對照表
 * ACD→TG 對照表由 buildTgAcdMap() 從 Excel 提料單 + DWG 檔名建立，
 * 比純檔名匹配更全面，涵蓋跨目錄嘅 TG 位置圖。
 */
function resolveTgFiles(filePath, extraTargets) {
    // 1. 同目錄檔名匹配
    const tagFiles = getTagFiles(filePath);

    // 2. ACD→TG 對照表查詢
    if (_tgAcdMap && extraTargets && extraTargets.length > 0) {
        const seen = new Set(tagFiles);
        for (const target of extraTargets) {
            const clean = target.replace(/[-_]/g, '').toUpperCase();
            const mapped = _tgAcdMap[clean];
            if (mapped && Array.isArray(mapped)) {
                for (const tgPath of mapped) {
                    if (!seen.has(tgPath)) {
                        tagFiles.push(tgPath);
                        seen.add(tgPath);
                    }
                }
            }
        }
    }

    return tagFiles;
}

/** 找同名但不同副檔名的檔案（如 PDF → DWG） */
function findMatchingFile(filePath, targetExt) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const target = path.join(dir, base + targetExt);
    if (fs.existsSync(target)) return target;
    // 大小寫不敏感嘗試
    try {
        const entries = fs.readdirSync(dir);
        const want = (base + targetExt).toUpperCase();
        for (const f of entries) {
            if (f.toUpperCase() === want) return path.join(dir, f);
        }
    } catch {
        /* ignore */
    }
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

/** 提取繪圖編號嘅「系統前綴」（取前面 2-4 個字母） */
function getSystemPrefix(drawingNumber) {
    const m = drawingNumber.match(/^([A-Z]{2,4})/);
    return m ? m[1] : '';
}

/**
 * 拆解繪圖編號嘅所有可能前綴碼（用於智能關聯比對）
 * 例如：
 *   'CPBMSA5014' → ['CPB', 'MSA']
 *   'MSA5014'    → ['MSA']
 *   'FST5001'    → ['FST']
 *   'PBMSB5008'  → ['PB', 'MSB']（PBMS 4字母會切做 PB + MS）
 *   'BMSBS002'   → ['BMSB']（無法再拆）
 */
function extractPrefixes(drawingNum) {
    const clean = drawingNum.replace(/[-_]/g, '');
    const result = [];

    // 兩個 code + 數字：XXYYNNNN（如 CPBMSA5014）
    let m = clean.match(/^([A-Z]{2,4})([A-Z]{2,4})(\d{3,6})$/);
    if (m) {
        result.push(m[1], m[2]);
        return result;
    }

    // 一個 code + 數字：XXNNNN（如 MSA5014）
    m = clean.match(/^([A-Z]{2,4})(\d{3,6})$/);
    if (m) {
        result.push(m[1]);
        return result;
    }

    return result;
}

/**
 * 智能評估 TG 與目標圖紙嘅關聯性（取代舊 folder-level match）
 * 當精確文字匹配失敗時，用此函數判斷 TG 是否可能相關
 *
 * @param {object} tgData - TG 快取資料 { drawingNumbers, text, ocrText }
 * @param {string[]} targetNumbers - 目標繪圖編號（已清理，如 ['MSA5014']）
 * @returns {{ relevant: boolean, reasons: string[] }}
 */
function assessTgRelevance(tgData, targetNumbers) {
    const tgNumbers = tgData.drawingNumbers || [];
    if (!tgNumbers || tgNumbers.length === 0) {
        return { relevant: false, reasons: [] };
    }

    // 建立 TG 前綴 → 數值列表（方便範圍比對）
    const tgPrefixMap = {};
    for (const tgN of tgNumbers) {
        const prefixes = extractPrefixes(tgN);
        const numMatch = tgN.match(/(\d{3,6})$/);
        const num = numMatch ? parseInt(numMatch[1], 10) : null;
        for (const p of prefixes) {
            if (!tgPrefixMap[p]) tgPrefixMap[p] = [];
            if (num !== null) tgPrefixMap[p].push(num);
        }
    }

    const reasons = new Set();

    for (const target of targetNumbers) {
        const targetPrefixes = extractPrefixes(target);
        const numMatch = target.match(/(\d{3,6})$/);
        const targetNum = numMatch ? parseInt(numMatch[1], 10) : null;

        for (const prefix of targetPrefixes) {
            if (tgPrefixMap[prefix]) {
                const nums = tgPrefixMap[prefix];
                const min = Math.min(...nums);
                const max = Math.max(...nums);

                if (targetNum !== null) {
                    if (targetNum >= min && targetNum <= max) {
                        reasons.add(`${prefix} 範圍 ${min}-${max}，包含目標 ${targetNum}`);
                    } else {
                        const dist = Math.min(
                            Math.abs(targetNum - min),
                            Math.abs(targetNum - max)
                        );
                        if (dist <= 100) {
                            reasons.add(`${prefix} 範圍 ${min}-${max}，目標 ${targetNum} 相距 ${dist}`);
                        } else {
                            reasons.add(`同碼 ${prefix}（TG ${min}-${max}，目標 ${targetNum}）`);
                        }
                    }
                } else {
                    reasons.add(`同碼 ${prefix}`);
                }
            }
        }
    }

    return {
        relevant: reasons.size > 0,
        reasons: [...reasons],
    };
}

/** 格式化繪圖編號：ACD1226 → ACD-1226（僅在字母+數字時加分隔） */
function fmtDrawingNumber(n) {
    const m = n.match(/^([A-Z]+)(\d+)$/);
    return m ? m[1] + '-' + m[2] : n;
}

/** 從檔名提取純字母系統碼（唔使數字），用於 TG 結構匹配 */
function extractLetterCodes(filename) {
    const upper = filename.toUpperCase();
    const tokens = upper.split(/[-_\s.]+/);
    const codes = [];
    for (const token of tokens) {
        if (/^[A-Z]{2,4}$/.test(token) && !TG_EXCLUDE.has(token)) {
            codes.push(token);
        }
    }
    return codes;
}

/** 從 PDF 提取文字內容，含快取 */
async function extractTextFromPdf(filePath) {
    const cache = dataStore.get(TG_CACHE_KEY, {});

    // 檢查快取（失敗結果唔快取，等佢重試）
    const stat = fs.statSync(filePath);
    const cached = cache[filePath];
    if (
        cached &&
        cached.mtime === stat.mtimeMs &&
        cached.extractedAt &&
        !cached.error
    ) {
        return {
            text: cached.text || '',
            numbers: cached.drawingNumbers || [],
            fromCache: true,
        };
    }

    try {
        const dataBuffer = fs.readFileSync(filePath);
        const uint8 = new Uint8Array(dataBuffer);
        const doc = await pdfjs.getDocument({ data: uint8 }).promise;
        let fullText = '';
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map((item) => item.str).join(' ');
            fullText += pageText + '\n';
        }

        // pdfjs 無文字 → fallback MuPDF 提取向量文字
        if (!fullText.trim()) {
            try {
                const mupdf = await import('mupdf');
                const mdoc = mupdf.PDFDocument.openDocument(
                    dataBuffer,
                    'application/pdf'
                );
                let mupdfText = '';
                const pageCount = mdoc.countPages();
                for (let i = 0; i < Math.min(pageCount, 5); i++) {
                    const mp = mdoc.loadPage(i);
                    const stext = mp.toStructuredText();
                    mupdfText += stext.asText() + '\n';
                }
                fullText = mupdfText;
            } catch (mupdfErr) {
                /* MuPDF 都失敗就保留空白 */
            }
        }

        const numbers = extractDrawingNumbers(fullText);

        // 寫入快取（重新讀取避免寫入競爭）
        const latestCache = dataStore.get(TG_CACHE_KEY, {});
        latestCache[filePath] = {
            extractedAt: new Date().toISOString(),
            mtime: stat.mtimeMs,
            text: fullText.substring(0, 5000),
            drawingNumbers: numbers,
        };
        dataStore.set(TG_CACHE_KEY, latestCache);

        return { text: fullText, numbers, fromCache: false };
    } catch (err) {
        console.error(`❌ 無法讀取 PDF 文字 (${filePath}):`, err.message);
        // 快取失敗結果避免重複嘗試（重新讀取避免寫入競爭）
        const errCache = dataStore.get(TG_CACHE_KEY, {});
        errCache[filePath] = {
            extractedAt: new Date().toISOString(),
            mtime: stat.mtimeMs,
            text: '',
            drawingNumbers: [],
            error: err.message,
        };
        dataStore.set(TG_CACHE_KEY, errCache);
        return {
            text: '',
            numbers: [],
            fromCache: false,
            error: err.message,
        };
    }
}

/**
 * 從 PDF 逐頁提取文字內容（section 級別分析）
 * @param {string} filePath - PDF 檔案路徑
 * @param {number} [maxPages=20] - 最多提取頁數
 * @returns {Promise<Array<{pageNum: number, text: string, numbers: string[]}>>}
 */
async function extractTextPerPage(filePath, maxPages = 20) {
    try {
        const dataBuffer = fs.readFileSync(filePath);
        const uint8 = new Uint8Array(dataBuffer);
        const doc = await pdfjs.getDocument({ data: uint8 }).promise;
        const totalPages = Math.min(doc.numPages, maxPages);
        const pages = [];

        for (let i = 1; i <= totalPages; i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map((item) => item.str).join(' ');
            const numbers = extractDrawingNumbers(pageText);
            pages.push({
                pageNum: i,
                text: pageText.substring(0, 3000),
                numbers,
            });
        }

        // 如果全部頁都無文字，試 MuPDF fallback
        const hasAnyText = pages.some((p) => p.text.trim().length > 0);
        if (!hasAnyText) {
            try {
                const mupdf = await import('mupdf');
                const mdoc = mupdf.PDFDocument.openDocument(
                    dataBuffer,
                    'application/pdf'
                );
                const mupdfPages = Math.min(mdoc.countPages(), maxPages);
                const mupdfResults = [];
                for (let i = 0; i < mupdfPages; i++) {
                    const mp = mdoc.loadPage(i);
                    const stext = mp.toStructuredText();
                    const pageText = stext.asText();
                    const numbers = extractDrawingNumbers(pageText);
                    mupdfResults.push({
                        pageNum: i + 1,
                        text: pageText.substring(0, 3000),
                        numbers,
                    });
                }
                return mupdfResults;
            } catch (mupdfErr) {
                /* MuPDF fallback 失敗 */
            }
        }

        return pages;
    } catch (err) {
        console.error(`❌ 逐頁提取失敗 (${filePath}):`, err.message);
        return [];
    }
}

/**
 * Section 對比：列出 TG 檔案嘅頁面級別繪圖編號
 * @param {string[]} tgFilePaths - TG PDF 路徑列表
 * @param {string[]} targetNumbers - 目標繪圖編號（已清理）
 * @returns {Promise<Array<{path, name, totalNumbers, matchedNumbers, pages: Array<{pageNum, numbers}>}>>}
 */
async function scanTgSections(tgFilePaths, targetNumbers = []) {
    const results = [];
    const targetSet = new Set(targetNumbers);

    const pdfPaths = tgFilePaths.filter(
        (p) => path.extname(p).toLowerCase() === '.pdf'
    );

    for (const tgPath of pdfPaths) {
        const name = path.basename(tgPath);
        const pages = await extractTextPerPage(tgPath);
        const allNumbers = [];
        const pageMatches = [];

        for (const p of pages) {
            // 每頁嘅繪圖編號
            allNumbers.push(...p.numbers);
            const pageTargetMatch = p.numbers.filter((n) => targetSet.has(n));
            if (pageTargetMatch.length > 0) {
                pageMatches.push({
                    pageNum: p.pageNum,
                    matchCount: pageTargetMatch.length,
                    matchedNumbers: pageTargetMatch,
                });
            }
        }

        // 全 TG 去重後嘅繪圖編號
        const uniqueNumbers = [...new Set(allNumbers)];
        const matchedNumbers = targetNumbers.filter((n) =>
            uniqueNumbers.some((un) => un === n || un.includes(n) || n.includes(un))
        );

        results.push({
            path: tgPath,
            name,
            totalNumbers: uniqueNumbers.length,
            matchedNumbers,
            pageMatches,
            pages: pages.map((p) => ({
                pageNum: p.pageNum,
                numberCount: p.numbers.length,
                numbers: p.numbers.slice(0, 20), // 最多 20 個 per page
            })),
        });
    }

    return results;
}

/**
 * 掃描 TG 檔案，搵出與目標繪圖編號相關嘅檔案
 * @param {string[]} [allTargetNumbers] - 所有從檔名提取嘅目標編號，用於檔名匹配
 * @returns {Array<{path, name, relevance, matchedNumbers}>}
 */
async function scanTgFilesForDrawing(
    tgFilePaths,
    targetDrawingNumber,
    targetPrefix,
    allTargetNumbers = []
) {
    const results = [];

    // 只處理 PDF 版本嘅 TG（DWG 係 CAD 原始檔，同一份圖）
    const pdfPaths = tgFilePaths.filter(
        (p) => path.extname(p).toLowerCase() === '.pdf'
    );

    for (const tgPath of pdfPaths) {
        const name = path.basename(tgPath);

        // 所有目標編號（已清理，無重複）
        const cleanTarget = targetDrawingNumber
            .replace(/[-_]/g, '')
            .toUpperCase();
        const allTargets = [
            cleanTarget,
            ...allTargetNumbers.map((n) =>
                n.replace(/[-_]/g, '').toUpperCase()
            ),
        ];
        const uniqueTargets = [...new Set(allTargets)];

        // ── 第1關：pdfjs/MuPDF 文字提取（精確） ──
        const {
            text,
            numbers: pdfNumbers,
            fromCache,
            error,
        } = await extractTextFromPdf(tgPath);
        const hasText = text && text.trim().length > 0;

        if (hasText && !error) {
            // 成功提取文字 → 精確匹配
            const pdfMatches = uniqueTargets.filter((t) =>
                pdfNumbers.some((n) => n === t)
            );
            if (pdfMatches.length > 0) {
                results.push({
                    path: tgPath,
                    name,
                    relevance: 'exact',
                    matchedNumbers: pdfMatches.slice(0, 15),
                    fromCache,
                });
                continue;
            }
            // 有文字但無精確匹配 → 智能關聯評估
            const cacheEntry = dataStore.get(TG_CACHE_KEY, {})[tgPath];
            if (cacheEntry) {
                const assessment = assessTgRelevance(cacheEntry, uniqueTargets);
                if (assessment.relevant) {
                    results.push({
                        path: tgPath,
                        name,
                        relevance: 'suggested',
                        matchedNumbers: uniqueTargets,
                        reasons: assessment.reasons,
                        fromCache: true,
                    });
                    continue;
                }
            }
            // 有文字但評估後無關聯 → 確定唔關
            continue;
        }

        // ── 第2關：OCR 快取（掃描 PDF 嘅後備） ──
        const ocrResult = checkOcrCache(tgPath, uniqueTargets);
        const hasOcrData = ocrResult !== null; // null = 未有 OCR 記錄
        const hasOcrMatch = ocrResult && ocrResult.matched.length > 0;

        if (hasOcrData) {
            if (hasOcrMatch) {
                // OCR 確認包含目標編號
                results.push({
                    path: tgPath,
                    name,
                    relevance: 'exact',
                    matchedNumbers: ocrResult.matched.slice(0, 15),
                    fromCache: true,
                });
                continue;
            }
            // OCR 有資料但無精確匹配 → 智能關聯評估
            const cacheEntry = dataStore.get(TG_CACHE_KEY, {})[tgPath];
            if (cacheEntry) {
                const assessment = assessTgRelevance(cacheEntry, uniqueTargets);
                if (assessment.relevant) {
                    results.push({
                        path: tgPath,
                        name,
                        relevance: 'suggested',
                        matchedNumbers: uniqueTargets,
                        reasons: assessment.reasons,
                        fromCache: true,
                    });
                    continue;
                }
            }
            // OCR 有資料但評估後無關聯 → 確定唔關
            continue;
        }

        // ── 第3關：冇文字、冇 OCR → 即時 OCR（唔可以叫用戶等下次） ──
        try {
            const ocrNow = await ocrTgPdf(tgPath);
            if (ocrNow.numbers && ocrNow.numbers.length > 0) {
                const ocrMatches = uniqueTargets.filter((t) =>
                    ocrNow.numbers.some((n) => n === t)
                );
                if (ocrMatches.length > 0) {
                    results.push({
                        path: tgPath,
                        name,
                        relevance: 'exact',
                        matchedNumbers: ocrMatches.slice(0, 15),
                        fromCache: false,
                    });
                    continue;
                }
                // OCR 有結果但冇精確匹配 → 智能關聯評估
                const cacheEntry = dataStore.get(TG_CACHE_KEY, {})[tgPath];
                if (cacheEntry) {
                    const assessment = assessTgRelevance(cacheEntry, uniqueTargets);
                    if (assessment.relevant) {
                        results.push({
                            path: tgPath,
                            name,
                            relevance: 'suggested',
                            matchedNumbers: uniqueTargets,
                            reasons: assessment.reasons,
                            fromCache: false,
                        });
                        continue;
                    }
                }
            }
        } catch (err) {
            console.error(`❌ 即時 OCR 失敗 (${tgPath}):`, err.message);
        }
        continue;
    }

    // 排序：精確匹配優先
    results.sort((a, b) => {
        const order = { exact: 0, suggested: 1 };
        return (order[a.relevance] || 9) - (order[b.relevance] || 9);
    });

    return results;
}

/** 取得 TG 內容快取統計 */
function getTgCacheStats() {
    const cache = dataStore.get(TG_CACHE_KEY, {});
    const entries = Object.keys(cache);
    const withContent = entries.filter(
        (k) => cache[k].drawingNumbers && cache[k].drawingNumbers.length > 0
    );
    return { total: entries.length, withContent: withContent.length };
}

// ========== OCR 文字識別（MuPDF 渲染 + Tesseract） ==========

/**
 * 背景 OCR：渲染 TG PDF 為圖片 → Tesseract 識別 → 快取繪圖編號
 *
 * 採用漸進式解析度：6x → 8x → 10x，逐級提升。
 * 每級結果獨立累積，強制行晒所有 scale 以確保最高召回率。
 */
async function ocrTgPdf(filePath) {
    const cache = dataStore.get(TG_CACHE_KEY, {});
    const cached = cache[filePath];

    const SCALES = [6.0, 8.0, 10.0];
    const MAX_SCALE = SCALES[SCALES.length - 1];

    // 已有最高解析度結果 → 跳過
    if (cached && cached.ocrText && cached.ocrText.length > 10 && cached.ocrScale === MAX_SCALE) {
        return { numbers: cached.drawingNumbers || [], fromCache: true };
    }

    try {
        // 動態 import MuPDF（ESM module）
        const mupdf = await import('mupdf');

        const dataBuffer = fs.readFileSync(filePath);
        const doc = mupdf.PDFDocument.openDocument(
            dataBuffer,
            'application/pdf'
        );
        const page = doc.loadPage(0);

        // 從現有 cache 開始累積編號
        let allNumbers = [...(cached?.drawingNumbers || [])];
        let bestText = cached?.ocrText || '';
        let achievedScale = 0;

        for (const scale of SCALES) {
            // 已 cache 過呢個 scale → 直接累加，唔重新 OCR
            if (cached && cached.ocrScale === scale && cached.drawingNumbers) {
                const merged = new Set([...allNumbers, ...cached.drawingNumbers]);
                allNumbers = [...merged];
                if (cached.ocrText && cached.ocrText.length > bestText.length) {
                    bestText = cached.ocrText;
                }
                achievedScale = scale;
                continue;
            }

            const matrix = mupdf.Matrix.scale(scale, scale);
            const pixmap = page.toPixmap(
                matrix,
                mupdf.ColorSpace.DeviceRGB,
                false
            );
            const pngData = pixmap.asPNG();

            // Tesseract OCR
            const {
                data: { text },
            } = await Tesseract.recognize(pngData, 'eng');

            const numbers = extractDrawingNumbers(text);
            const merged = new Set([...allNumbers, ...numbers]);
            allNumbers = [...merged];
            if (text.length > bestText.length) bestText = text;
            achievedScale = scale;

            console.log(
                `👁️ OCR scale ${scale}: ${path.basename(filePath)} → ${numbers.length} 個（累計 ${allNumbers.length} 個）`
            );
        }

        // 更新快取（重新讀取避免寫入競爭）
        const stat = fs.statSync(filePath);
        const latestCache = dataStore.get(TG_CACHE_KEY, {});
        latestCache[filePath] = {
            ...(latestCache[filePath] || {}),
            extractedAt: new Date().toISOString(),
            mtime: stat.mtimeMs,
            ocrText: bestText.substring(0, 10000),
            drawingNumbers: allNumbers,
            ocrScale: achievedScale,
        };
        dataStore.set(TG_CACHE_KEY, latestCache);

        const scaleInfo =
            achievedScale > 0
                ? `（最高 scale ${achievedScale}）`
                : '（從 cache 累積）';
        console.log(
            `👁️ OCR 完成: ${path.basename(filePath)} → ${allNumbers.length} 個繪圖編號 ${scaleInfo}`
        );
        return { numbers: allNumbers, fromCache: false };
    } catch (err) {
        console.error(`❌ OCR 失敗 (${filePath}):`, err.message);
        return { numbers: [], fromCache: false, error: err.message };
    }
}

/** 背景觸發：用戶下載 TG 後，非同步 OCR 記錄繪圖編號 */
function ocrTgInBackground(tgPaths) {
    if (!tgPaths || tgPaths.length === 0) return;
    // 逐個執行避免 app.json 寫入競爭（background，唔 await）
    (async () => {
        for (const tgPath of tgPaths) {
            const ext = path.extname(tgPath).toLowerCase();
            if (ext === '.pdf') {
                try {
                    await ocrTgPdf(tgPath);
                } catch (err) {
                    console.error(`❌ 背景 OCR 失敗 (${tgPath}):`, err.message);
                }
            }
        }
    })();
}

/** 查 OCR 快取：TG 檔案係咪包含目標繪圖編號 */
function checkOcrCache(tgPath, targetNumbers) {
    const cache = dataStore.get(TG_CACHE_KEY, {});
    const cached = cache[tgPath];
    if (
        !cached ||
        !cached.drawingNumbers ||
        cached.drawingNumbers.length === 0
    ) {
        return null; // 未有 OCR 記錄
    }
    const matched = targetNumbers.filter((n) =>
        cached.drawingNumbers.some(
            (cn) => cn === n || cn.includes(n) || n.includes(cn)
        )
    );
    if (matched.length > 0) {
        return { matched, fromCache: true };
    }
    return { matched: [], fromCache: true }; // 有 OCR 記錄但冇匹配
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

            // ── #R 返回上一層 ──
            if (input === '#R') {
                return _goBack(ctx);
            }

            // ── 階段1：模糊輸入 ──
            if (ctx.step === 'input') {
                if (!rawInput) {
                    return {
                        question:
                            '❌ 請輸入圖紙編號（空格分隔條件）。\n輸入 `#cancel` 取消。',
                    };
                }
                const results = searchDrawings(rawInput);

                if (results.length === 0) {
                    return {
                        question: `❌ 找不到符合 "${rawInput}" 的圖紙。\n\n請重新輸入編號（#R 返回 / #cancel 取消）：`,
                    };
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
                    return {
                        question: `❌ 請輸入 1-${ctx.materialCodes.length} 的數字，\`0\` 跳過篩選，\`#R\` 返回。`,
                    };
                }

                const [code] = ctx.materialCodes[idx];
                const filtered = ctx.allResults.filter(
                    (f) => f.materials && f.materials.includes(code)
                );
                ctx.filteredResults = filtered;
                ctx.backStep = 'filter_material';
                return _showSystemOrPdf(ctx, filtered);
            }

            // ── 階段3：系統碼（項目）篩選 ──
            if (ctx.step === 'filter_system') {
                if (input === '0') {
                    ctx.backStep = 'filter_system';
                    return _showPdfSelection(ctx, ctx.filteredResults);
                }

                const idx = parseInt(input, 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= ctx.systemCodes.length) {
                    return {
                        question: `❌ 請輸入 1-${ctx.systemCodes.length} 的數字，\`0\` 跳過篩選，\`#R\` 返回。`,
                    };
                }

                const [sysCode] = ctx.systemCodes[idx];
                const filtered = ctx.filteredResults.filter(
                    (f) =>
                        (f.systems && f.systems.includes(sysCode)) ||
                        f.system === sysCode
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
                        return {
                            question: `❌ 頁碼超出範圍（1-${totalPages}）。\n請輸入 \`p1\`-\`p${totalPages}\`，或 \`#R\` 返回。`,
                        };
                    }
                    return _showPdfSelection(ctx, ctx.allPdfs, targetPage);
                }

                const num = parseInt(input, 10);
                if (isNaN(num) || num < 1 || num > ctx.allPdfs.length) {
                    const extra =
                        ctx.allPdfs.length > 10
                            ? `，\`p1\`-\`p${Math.ceil(ctx.allPdfs.length / 10)}\` 翻頁`
                            : '';
                    return {
                        question: `❌ 請輸入 1-${ctx.allPdfs.length} 的數字${extra}，或 \`#R\` 返回。`,
                    };
                }

                const pageSize = 10;
                const globalIndex = num - 1;
                const currentPage = ctx.currentPage || 1;
                const pageStart = (currentPage - 1) * pageSize;
                const localIndex = globalIndex - pageStart;
                if (localIndex < 0 || localIndex >= ctx.shownResults.length) {
                    const targetPage = Math.floor(globalIndex / pageSize) + 1;
                    return _showPdfSelection(ctx, ctx.allPdfs, targetPage);
                }
                const selected = ctx.shownResults[localIndex];
                ctx.selectedFile = selected.path;
                ctx.selectedName = selected.name;
                ctx.selectedPor = selected.por || '';
                ctx.selectedSystem = selected.system || '';
                ctx.selectedBase = path.basename(
                    selected.name,
                    path.extname(selected.name)
                );

                ctx.hasDwg =
                    !!findMatchingFile(selected.path, '.dwg') ||
                    !!findMatchingFile(selected.path, '.DWG');
                ctx.hasDxf =
                    !ctx.hasDwg &&
                    (!!findMatchingFile(selected.path, '.dxf') ||
                        !!findMatchingFile(selected.path, '.DXF'));

                let question =
                    `✅ 已選擇 PDF: *${selected.name}*\n` +
                    `🏢 POR: ${selected.por || '未知'}\n` +
                    (selected.system ? `🔧 系統: ${selected.system}\n` : '') +
                    '\n💡 輸入 `#R` 返回重新選擇';

                ctx.backStep = 'select';
                if (ctx.hasDwg) {
                    ctx.step = 'ask_dwg';
                    question +=
                        '\n\n📎 發現同名 *.dwg* 加工圖\n需要一併發送 DWG 圖嗎？\n回覆 `y` 或 `n`';
                } else if (ctx.hasDxf) {
                    ctx.step = 'ask_dwg';
                    question +=
                        '\n\n📎 發現同名 *.dxf* 加工圖\n需要一併發送 DXF 圖嗎？\n回覆 `y` 或 `n`';
                } else {
                    // 無 DWG/DXF → 自動掃描 TG 位置圖（同目錄 OCR）
                    const tagFiles = getTagFiles(ctx.selectedFile);
                    ctx.tagFiles = tagFiles;
                    ctx.wantDwg = false;
                    if (tagFiles.length > 0) {
                        return await _scanAndShowRelevantTg(ctx);
                    }
                    return _buildSendResult(ctx, []);
                }
                return { question };
            }

            // ── 階段5：是否發送 DWG ──
            if (ctx.step === 'ask_dwg') {
                const isYes = ['Y', 'YES', '是', '確認', 'OK'].includes(input);
                const isNo = ['N', 'NO'].includes(input);
                if (!isYes && !isNo) {
                    return {
                        question:
                            '❌ 請輸入 `y`（是）或 `n`（否），或 `#R` 返回。',
                    };
                }

                ctx.wantDwg = isYes;
                const tagFiles = getTagFiles(ctx.selectedFile);
                ctx.tagFiles = tagFiles;

                ctx.backStep = 'ask_dwg';
                if (tagFiles.length > 0) {
                    return await _scanAndShowRelevantTg(ctx);
                }
                return _buildSendResult(ctx, []);
            }

            // ── 階段6：TG 檔案選擇 ──
            if (ctx.step === 'select_tg') {
                if (input === 'V') {
                    return await _showTgDetail(ctx);
                }
                return _handleTgSelection(ctx, input);
            }

            // ── 階段7：詳細 Section 對比 ──
            if (ctx.step === 'show_detail') {
                if (input === '#R' || input === '#R'.toUpperCase()) {
                    return _goBack(ctx);
                }
                return {
                    question: '輸入 `#R` 返回位置圖列表 | `#cancel` 取消',
                };
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

// ── Helper: 系統碼（項目）篩選介面 ──
function _askSystemFilter(ctx, results) {
    ctx.step = 'filter_system';
    const systemCodes = extractSystemCodes(results);
    ctx.systemCodes = systemCodes;

    let question = `⚠️ 找到 *${results.length}* 個匹配結果（>${MAX_RESULTS}）\n\n`;
    question += '*請選擇項目（系統碼）：*\n\n';

    systemCodes.forEach(([code, count], i) => {
        question += `${i + 1}. ${code} — ${count} 個\n`;
    });
    question += '\n輸入 `0` 跳過篩選\n輸入 `#cancel` 取消';

    return { question };
}

// ── Helper: 物料碼篩選介面 ──
function _askMaterialFilter(ctx, results) {
    ctx.step = 'filter_material';
    ctx.filteredResults = results;
    const materialCodes = extractMaterialCodes(results);
    ctx.materialCodes = materialCodes;

    let question = `⚠️ 仍有 *${results.length}* 個結果（>${MAX_RESULTS}）\n\n`;
    question += '*請選擇物料類型：*\n\n';

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
    if (results.length > MAX_RESULTS && systemCodes.length >= 2) {
        return _askSystemFilter(ctx, results);
    }
    return _showPdfSelection(ctx, results);
}

// ── Helper: 顯示 PDF 選擇列表（支援分頁） ──
function _showPdfSelection(ctx, results, page) {
    ctx.step = 'select';
    // 只顯示 PDF
    const pdfs = results.filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    ctx.allPdfs = pdfs;
    const pageSize = 10;
    const p = page || 1;
    const totalPages = Math.ceil(pdfs.length / pageSize);
    const start = (p - 1) * pageSize;
    const shown = pdfs.slice(start, start + pageSize);
    ctx.shownResults = shown;
    ctx.currentPage = p;

    let question = `🔍 找到 *${pdfs.length}* 個 PDF 圖紙`;
    if (results.length > pdfs.length) {
        question += `（另有 ${results.length - pdfs.length} 個 DWG/DXF 未顯示）`;
    }
    if (pdfs.length > pageSize) question += ` | 第 ${p}/${totalPages} 頁`;
    question += '：\n\n';

    shown.forEach((f, i) => {
        const num = start + i + 1;
        question += `${num}. *${f.name}*\n`;
        question += `   🏢 ${f.por || '--'} | 🔧 ${f.system || '--'}\n`;
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

    if (back === 'filter_material') {
        return _askMaterialFilter(ctx, ctx.allResults);
    }
    if (back === 'filter_system') {
        return _askSystemFilter(ctx, ctx.filteredResults);
    }
    if (back === 'select') {
        return _showPdfSelection(ctx, ctx.allPdfs, ctx.currentPage || 1);
    }
    if (back === 'ask_dwg') {
        let question =
            `✅ 已選擇 PDF: *${ctx.selectedName}*\n` +
            `🏢 POR: ${ctx.selectedPor || '未知'}\n` +
            (ctx.selectedSystem ? `🔧 系統: ${ctx.selectedSystem}\n` : '') +
            '\n💡 輸入 `#R` 返回重新選擇';
        if (ctx.hasDwg) {
            question +=
                '\n\n📎 發現同名 *.dwg* 加工圖\n需要一併發送 DWG 圖嗎？\n回覆 `y` 或 `n`';
        } else {
            question +=
                '\n\n📎 發現同名 *.dxf* 加工圖\n需要一併發送 DXF 圖嗎？\n回覆 `y` 或 `n`';
        }
        return { question };
    }

    if (back === 'select_tg') {
        if (ctx.relevantTgFiles && ctx.relevantTgFiles.length > 0) {
            return _showRelevantTgSelection(ctx);
        }
        return _buildSendResult(ctx, []);
    }

    if (back === 'show_detail') {
        if (ctx.relevantTgFiles && ctx.relevantTgFiles.length > 0) {
            return _showRelevantTgSelection(ctx);
        }
        return _buildSendResult(ctx, []);
    }

    // fallback
    ctx.step = 'input';
    return { question: '❌ 無法返回，請重新輸入圖紙編號：' };
}

// ── 掃描 TG 並自動篩選相關位置圖 ──
async function _scanAndShowRelevantTg(ctx) {
    const tagFiles = ctx.tagFiles;

    // 從檔名提取繪圖編號（如 WCA0606、FAC1060）
    const baseUpper = ctx.selectedBase.toUpperCase();
    const drawingNumbers = extractDrawingNumbers(baseUpper);
    ctx.targetNumbers = drawingNumbers;

    // 優先用檔案嘅 system 做前綴，否則由提取嘅編號推算
    const targetPrefix =
        ctx.selectedSystem ||
        (drawingNumbers.length > 0 ? getSystemPrefix(drawingNumbers[0]) : '');
    const primaryNumber =
        drawingNumbers.length > 0 ? drawingNumbers[0] : baseUpper;

    // 掃描 TG 檔案，用所有提取到嘅編號做匹配
    const relevant = await scanTgFilesForDrawing(
        tagFiles,
        primaryNumber,
        targetPrefix,
        drawingNumbers
    );
    ctx.relevantTgFiles = relevant;

    if (relevant.length === 0) {
        // OCR 未能匹配 → 列出所有可用位置圖俾用戶手動選擇
        const allTgEntries = tagFiles.map((fp) => ({
            path: fp,
            name: path.basename(fp),
            relevance: 'available',
            matchedNumbers: [],
        }));
        ctx.relevantTgFiles = allTgEntries;
        ctx.onlySuggested = true;
        const selection = _showRelevantTgSelection(ctx);
        selection.question =
            '⚠️ OCR 未能自動匹配包含目標編號嘅位置圖。\n以下係所有可用位置圖，請手動選擇：\n\n' +
            selection.question;
        return selection;
    }

    // 若只有關聯匹配（冇精確匹配），加說明
    const hasExact = relevant.some((r) => r.relevance === 'exact');
    if (!hasExact) {
        ctx.onlySuggested = true;
    }

    return _showRelevantTgSelection(ctx);
}

// ── TG 相關位置圖選擇介面 ──
function _showRelevantTgSelection(ctx) {
    ctx.step = 'select_tg';
    const relevant = ctx.relevantTgFiles;

    let question = '📍 *位置圖*';
    if (ctx.onlySuggested) {
        question += '\n⚠️ 以下位置圖無精確文字匹配，係根據關聯分析推斷';
    }
    question += '\n\n';
    let counter = 1;
    ctx.tgFileMap = [];

    for (const r of relevant) {
        ctx.tgFileMap.push({ num: counter, path: r.path, name: r.name });

        if (r.relevance === 'exact') {
            const numsStr = r.matchedNumbers.length > 0
                ? ' 📋 ' + r.matchedNumbers.slice(0, 3).map(fmtDrawingNumber).join(', ')
                : '';
            question += `${counter}. ✅ ${r.name}${numsStr}\n`;
        } else if (r.relevance === 'suggested') {
            question += `${counter}. 🔍 ${r.name}（關聯匹配）\n`;
            if (r.reasons && r.reasons.length > 0) {
                question += `   💡 ${r.reasons.slice(0, 2).join('；')}\n`;
            }
        } else if (r.relevance === 'available') {
            question += `${counter}. 📄 ${r.name}\n`;
        }
        counter++;
    }

    question += '\n輸入數字選擇（逗號分隔，如 `1,3,5`）\n';
    question += '`v` 詳細對比（逐頁顯示繪圖編號）\n';
    question += '`0` 跳過 | `#R` 返回 | `#cancel` 取消';

    return { question };
}

/** 顯示 TG 詳細對比（逐頁繪圖編號） */
async function _showTgDetail(ctx) {
    ctx.step = 'show_detail';
    ctx.backStep = 'select_tg';
    const tagFiles = ctx.tagFiles;
    const targetNumbers = ctx.targetNumbers || [];

    let question = '🔬 *詳細 Section 對比*\n\n';

    const detail = await scanTgSections(tagFiles, targetNumbers);
    ctx.tgDetail = detail;

    for (const tg of detail) {
        question += `📄 *${tg.name}*\n`;
        question += `   全 TG 共 ${tg.totalNumbers} 個繪圖編號`;
        if (tg.matchedNumbers.length > 0) {
            question += `，匹配 ${tg.matchedNumbers.length} 個：${tg.matchedNumbers.map(fmtDrawingNumber).join(', ')}`;
        }
        question += '\n';

        if (tg.pageMatches.length > 0) {
            question += `   📑 匹配頁面：${tg.pageMatches.map((pm) => `P${pm.pageNum}`).join('、')}\n`;
        }

        // 顯示每頁頭 10 個編號
        const shownPages = tg.pages.slice(0, 5);
        for (const p of shownPages) {
            if (p.numbers.length > 0) {
                const pageNums = p.numbers.slice(0, 10).map(fmtDrawingNumber).join(', ');
                question += `   P${p.pageNum}: ${pageNums}${p.numbers.length > 10 ? '…' : ''}\n`;
            }
        }
        if (tg.pages.length > 5) {
            question += `   … 共 ${tg.pages.length} 頁\n`;
        }
        question += '\n';
    }

    question += '`#R` 返回位置圖列表 | `#cancel` 取消';
    return { question };
}

// ── 處理 TG 選擇 ──
function _handleTgSelection(ctx, input) {
    if (input === '0') {
        return _buildSendResult(ctx, []);
    }

    // 數字選擇（逗號分隔）
    const parts = input.split(/[,，\s]+/).filter(Boolean);
    const nums = [];
    for (const p of parts) {
        const n = parseInt(p, 10);
        if (isNaN(n)) {
            return {
                question: `❌ 無法識別 "${p}"。\n請輸入數字（逗號分隔，如 \`1,3,5\`），\`0\` 跳過，或 \`#R\` 返回。`,
            };
        }
        nums.push(n);
    }

    if (nums.length === 0) {
        return {
            question:
                '❌ 請輸入數字（逗號分隔，如 `1,3,5`），`0` 跳過，或 `#R` 返回。',
        };
    }

    const selected = [];
    const invalidNums = [];
    for (const n of nums) {
        const entry = ctx.tgFileMap.find((e) => e.num === n);
        if (entry) {
            selected.push(entry.path);
        } else {
            invalidNums.push(n);
        }
    }

    if (invalidNums.length > 0) {
        return {
            question: `❌ 編號 ${invalidNums.join(', ')} 無效。\n請輸入 1-${ctx.tgFileMap.length} 之間的數字，或 \`#R\` 返回。`,
        };
    }

    if (selected.length === 0) {
        return {
            question:
                '❌ 未選擇任何檔案。\n請輸入數字（逗號分隔，如 `1,3,5`），`0` 跳過，或 `#R` 返回。',
        };
    }

    return _buildSendResult(ctx, selected);
}

// ── 構建最終發送結果 ──
function _buildSendResult(ctx, tgPaths) {
    const files = [{ path: ctx.selectedFile, name: ctx.selectedName }];

    // 背景 OCR：用戶選擇下載嘅 TG PDF，非同步記錄繪圖編號
    ocrTgInBackground(Array.isArray(tgPaths) ? tgPaths : []);

    if (ctx.wantDwg) {
        const dwgPath =
            findMatchingFile(ctx.selectedFile, '.dwg') ||
            findMatchingFile(ctx.selectedFile, '.DWG');
        if (dwgPath)
            files.push({ path: dwgPath, name: path.basename(dwgPath) });
    }

    const tgSet = new Set(Array.isArray(tgPaths) ? tgPaths : []);
    for (const tp of tgSet) {
        files.push({ path: tp, name: path.basename(tp) });
    }

    let result = '📄 *圖紙發送中...*\n';
    if (ctx.selectedPor) {
        result += `🏢 POR: ${ctx.selectedPor}\n`;
    }
    // 匹配摘要：顯示加工圖 → 位置圖對應（含精準/關聯標記）
    if (ctx.relevantTgFiles && ctx.relevantTgFiles.length > 0) {
        const tgSelected = tgSet.size > 0 ? tgSet : new Set(tgPaths || []);
        const matched = ctx.relevantTgFiles
            .filter((r) => tgSelected.has(r.path))
            .map((r) => {
                const tag = r.relevance === 'exact' ? '✅' : '🔍';
                if (r.matchedNumbers.length > 0) {
                    const nums = r.matchedNumbers.map(fmtDrawingNumber).join(', ');
                    return `${tag} ${nums} → ${r.name}`;
                }
                return `${tag} ${r.name}`;
            });
        if (matched.length > 0) {
            result += matched.join('\n') + '\n';
        }
    }
    result += '\n';
    files.forEach((f, i) => {
        result += `${i + 1}. ${f.name}\n`;
    });

    return {
        done: true,
        result,
        attachments: files.map((f) => f.path),
        attachmentCaption: files.map((f) => f.name).join(' + '),
        completionMessage: '✅ 已完成所有發送',
    };
}

// ========== 自動重建（給 scheduler 用） ==========

async function autoRebuildTask(porPath, _client) {
    const result = await buildIndex(porPath);
    return result;
}

// ========== DWG 反向查詢：加工圖號 → 位置圖 ==========

/**
 * 從 TG ACD 對照表搵出指定加工圖號對應嘅位置圖
 * @param {string} drawingNumber - 加工圖號（如 ACD0060、ACB-ACD-0060）
 * @returns {{ found: boolean, drawingNumber: string, layoutFiles: string[], source: string }}
 */
function findLayoutByFabNumber(drawingNumber) {
    const index = loadIndex();
    const clean = drawingNumber.replace(/[-_]/g, '').toUpperCase();

    // 方法 1: TG-ACD 對照表（從 Excel + DWG 內容建立）
    if (_tgAcdMap && _tgAcdMap[clean]) {
        const tgPaths = Array.isArray(_tgAcdMap[clean])
            ? _tgAcdMap[clean]
            : [_tgAcdMap[clean]];
        return {
            found: true,
            drawingNumber: clean,
            layoutFiles: tgPaths,
            source: 'tgAcdMap',
        };
    }

    // 方法 2: 同目錄檔名匹配（fallback）
    for (const f of index) {
        const name = f.name.toUpperCase();
        if (name.includes(clean) || clean.includes(name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ''))) {
            const tgFiles = getTagFiles(f.path);
            if (tgFiles.length > 0) {
                return {
                    found: true,
                    drawingNumber: clean,
                    layoutFiles: tgFiles,
                    source: 'filename',
                };
            }
        }
    }

    return { found: false, drawingNumber: clean, layoutFiles: [], source: null };
}

/**
 * 掃描 TG 位置圖 DWG，提取其中所有加工圖號
 * @param {string} tgPath - TG DWG 檔案路徑
 * @returns {Promise<{numbers: string[], texts: string[], error?: string}>}
 */
async function scanLayoutDwg(tgPath) {
    if (!isDwgReaderAvailable()) {
        return { numbers: [], texts: [], error: 'dwgread 工具未安裝' };
    }

    const ext = path.extname(tgPath).toLowerCase();
    // 若是 PDF，嘗試搵同名 DWG
    let dwgPath = tgPath;
    if (ext === '.pdf') {
        const dwg = tgPath.replace(/\.pdf$/i, '.dwg').replace(/\.PDF$/, '.DWG');
        if (fs.existsSync(dwg)) {
            dwgPath = dwg;
        } else {
            return { numbers: [], texts: [], error: '找不到對應嘅 DWG 檔（CAD 線條 PDF 無法 OCR）' };
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
                question += '⚠️ *注意：* dwgread 工具未安裝，將使用檔名匹配（準確度較低）。\n';
            }
            question += '輸入 `#cancel` 取消';
            return { question };
        },

        async handleReply(ctx, replyMessage) {
            const input = replyMessage.body.trim().toUpperCase();
            if (input === '#CANCEL') {
                return { done: true, result: '❌ *查詢已取消*' };
            }
            if (!input) {
                return { question: '❌ 請輸入加工圖號。\n輸入 `#cancel` 取消。' };
            }

            // 查詢
            const result = findLayoutByFabNumber(input);

            if (!result.found) {
                return {
                    question:
                        `❌ 找不到加工圖號 *${input}* 對應嘅位置圖。\n\n` +
                        '可能原因：\n' +
                        '• 圖號不在 POR 目錄中\n' +
                        '• 請檢查圖號是否正確\n\n' +
                        '請重新輸入，或 `#cancel` 取消。',
                };
            }

            const tgNames = result.layoutFiles.map((p) => path.basename(p));
            let msg = `✅ *${result.drawingNumber}* 對應嘅位置圖：\n\n`;
            tgNames.forEach((name, i) => {
                msg += `${i + 1}. 📄 ${name}\n`;
            });
            msg += `\n來源：${result.source === 'tgAcdMap' ? 'Excel 提料單 + DWG 內容' : '檔名匹配'}`;
            msg += `\n\n💡 輸入 \`#dwgdetail ${result.drawingNumber}\` 查看位置圖包含嘅所有加工圖號`;

            ctx.foundResult = result;

            // 問要唔要發送位置圖
            if (result.layoutFiles.length > 0) {
                ctx.step = 'ask_send';
                ctx.tgFiles = result.layoutFiles;
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
    if (input === '#CANCEL') {
        return { done: true, result: '❌ *已取消*' };
    }

    const isYes = ['Y', 'YES', '是', '確認', 'OK'].includes(input);
    const isNo = ['N', 'NO'].includes(input);

    if (!isYes && !isNo) {
        return { question: '❌ 請輸入 `y`（是）或 `n`（否）。' };
    }

    if (isNo || ctx.tgFiles.length === 0) {
        return { done: true, result: '✅ *查詢完成*' };
    }

    const files = ctx.tgFiles.map((fp) => ({
        path: fp,
        name: path.basename(fp),
    }));

    return {
        done: true,
        result: `📄 *發送 ${files.length} 個位置圖檔案...*`,
        attachments: files.map((f) => f.path),
        attachmentCaption: files.map((f) => f.name).join(' + '),
    };
}

// 擴充 makeDwgFindHandler 支援 ask_send 階段
const _origMakeDwgFindHandler = makeDwgFindHandler;
makeDwgFindHandler = function () {
    const handler = _origMakeDwgFindHandler();
    const origHandleReply = handler.handleReply;
    handler.handleReply = async function (ctx, replyMessage) {
        if (ctx.step === 'ask_send') {
            return _handleDwgFindSend(ctx, replyMessage);
        }
        return origHandleReply.call(this, ctx, replyMessage);
    };
    return handler;
};

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
    extractTextFromPdf,
    extractTextPerPage,
    scanTgFilesForDrawing,
    scanTgSections,
    getTgCacheStats,
    ocrTgPdf,
    ocrTgInBackground,
    checkOcrCache,
    get indexLoaded() {
        return _indexLoaded;
    },
    findLayoutByFabNumber,
    scanLayoutDwg,
    makeDwgFindHandler,
    isDwgReaderAvailable,
    get cachedCount() {
        return _cachedIndex ? _cachedIndex.length : 0;
    },
};
