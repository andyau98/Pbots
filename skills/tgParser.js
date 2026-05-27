/**
 * TG (位置圖) 內容提取模組
 *
 * 從 TG 位置圖檔案提取文字內容，用於建立 Folder-Level 雙向索引：
 * folder → TG 檔案 → 包含嘅加工圖號 → 個別加工圖檔案
 *
 * 優先順序：DXF (純文字) > PDF 文字 (pdfjs-dist) > PDF OCR (MuPDF + Tesseract) > DWG (唔支援)
 *
 * 兩階段掃描：
 *   階段1 — 掃描所有 folder 嘅所有檔案，建立全域檔案索引
 *   階段2 — 提取 TG 內容，cross-reference 對應嘅加工圖檔案
 */

const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
const { dataStore } = require('../src/core/dataStore');

// === 常數 ===

/** 繪圖編號正則：2-4 大寫字母 + 可選分隔符 + 可選字母前綴 + 3-6 位數字 */
const DRAWING_NUMBER_RE = /[A-Z]{2,4}[-_]?(?:[A-Z])?\d{3,6}/g;

/** 非圖紙檔案類型 */
const NON_DRAWING_EXTS = new Set(['.xlsx', '.xls', '.zip', '.txt', '.json', '.js', '.css', '.html']);

/** TG 快取 key（同 drawingSearch.js 共用） */
const TG_CACHE_KEY = 'tg_content_cache_v2';

/** Folder 索引 key */
const TG_INDEX_KEY = 'tg_folder_index';

/** 全域檔案索引 key */
const FILE_INDEX_KEY = 'tg_file_registry';

// === 繪圖編號處理 ===

/**
 * 從文字提取繪圖編號
 * @param {string} text
 * @returns {string[]}
 */
function extractDrawingNumbers(text) {
    const matches = new Set();
    let m;
    DRAWING_NUMBER_RE.lastIndex = 0;
    while ((m = DRAWING_NUMBER_RE.exec(text)) !== null) {
        matches.add(m[0].replace(/[-_]/g, '').toUpperCase());
    }
    return [...matches];
}

/**
 * 清理繪圖編號（移除分隔符、統一格式）
 * @param {string} raw
 * @returns {string}
 */
function cleanDrawingNumber(raw) {
    return raw.replace(/[-_]/g, '').toUpperCase();
}

/**
 * 從檔名提取繪圖編號
 * e.g. "FHA760 HGRH-WWB0102-FHA760 前装铝料加工图" → ["FHA760", "WWB0102"]
 * @param {string} fileName
 * @returns {string[]}
 */
function extractNumbersFromFileName(fileName) {
    return extractDrawingNumbers(fileName);
}

// === DXF 解析 ===

/**
 * 從 DXF 提取文字內容（純文字解析，唔需要 WASM）
 * DXF group code 1 = TEXT/MTEXT 嘅文字值
 * DXF group code 3 = MTEXT 附加行
 * @param {string} filePath
 * @returns {string}
 */
function extractTextFromDxf(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const texts = [];

    for (let i = 0; i < lines.length - 1; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '1' || trimmed === '3') {
            const value = lines[i + 1]?.trim();
            if (value && value.length > 0 && !/^\d/.test(value)) {
                texts.push(value);
            }
        }
    }

    return texts.join(' ');
}

// === PDF 提取 ===

/**
 * 從 PDF 提取文字內容（用 pdfjs-dist）
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function extractTextFromPdf(filePath) {
    const dataBuffer = fs.readFileSync(filePath);
    const uint8 = new Uint8Array(dataBuffer);
    const doc = await pdfjs.getDocument({ data: uint8 }).promise;
    let fullText = '';

    try {
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map((item) => item.str).join(' ');
            fullText += pageText + '\n';
        }
    } finally {
        await doc.destroy();
    }

    return fullText;
}

/**
 * OCR TG PDF（MuPDF 渲染 + Tesseract 識別）
 * 漸進式解析度 6x → 8x → 10x
 * @param {string} filePath
 * @returns {Promise<{numbers: string[], text: string, sourceMethod: string}>}
 */
async function ocrTgPdf(filePath) {
    const cache = dataStore.get(TG_CACHE_KEY, {});
    const cached = cache[filePath];
    const SCALES = [6.0, 8.0, 10.0];
    const MAX_SCALE = SCALES[SCALES.length - 1];

    if (cached && cached.ocrText && cached.ocrText.length > 10 && cached.ocrScale === MAX_SCALE) {
        return {
            numbers: cached.drawingNumbers || [],
            text: cached.ocrText || '',
            sourceMethod: 'ocr_cache',
        };
    }

    try {
        const mupdf = await import('mupdf');
        const dataBuffer = fs.readFileSync(filePath);
        const doc = mupdf.PDFDocument.openDocument(dataBuffer, 'application/pdf');
        const numPages = doc.numPages || 1;

        const Tesseract = require('tesseract.js');
        let allNumbers = [...(cached?.drawingNumbers || [])];
        let bestText = cached?.ocrText || '';
        let achievedScale = 0;

        for (let p = 0; p < numPages; p++) {
            const page = doc.loadPage(p);

            for (const scale of SCALES) {
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
                const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
                const pngData = pixmap.asPNG();

                const { data: { text } } = await Tesseract.recognize(pngData, 'eng');
                const numbers = extractDrawingNumbers(text);
                const merged = new Set([...allNumbers, ...numbers]);
                allNumbers = [...merged];
                if (text.length > bestText.length) bestText = text;
                achievedScale = scale;

                console.log(`  👁️ OCR scale ${scale} page ${p + 1}: ${path.basename(filePath)} → ${numbers.length} 個（累計 ${allNumbers.length} 個）`);
            }
        }

        doc.destroy();

        const stat = fs.statSync(filePath);
        const latestCache = dataStore.get(TG_CACHE_KEY, {});
        latestCache[filePath] = {
            ...(latestCache[filePath] || {}),
            extractedAt: new Date().toISOString(),
            mtime: stat.mtimeMs,
            ocrText: bestText.substring(0, 10000),
            drawingNumbers: allNumbers,
            ocrScale: achievedScale,
            sourceMethod: 'ocr',
        };
        dataStore.set(TG_CACHE_KEY, latestCache);

        console.log(`  👁️ OCR 完成: ${path.basename(filePath)} → ${allNumbers.length} 個繪圖編號`);

        return {
            numbers: allNumbers,
            text: bestText.substring(0, 10000),
            sourceMethod: 'ocr',
        };
    } catch (err) {
        console.error(`  ❌ OCR 失敗 (${path.basename(filePath)}):`, err.message);
        return { numbers: [], text: '', sourceMethod: 'ocr_error' };
    }
}

// === TG 內容提取 ===

/**
 * 提取 TG 檔案內容（自動選擇最佳方法）
 * 優先順序：DXF (純文字) > PDF 文字 (pdfjs-dist) > PDF OCR (MuPDF+Tesseract) > DWG (唔支援)
 *
 * @param {string} filePath
 * @param {boolean} [useOcr=false] 是否啟用 OCR fallback
 * @returns {Promise<{text: string, drawingNumbers: string[], sourceMethod: string, error?: string, fromCache?: boolean}>}
 */
async function extractTgContent(filePath, useOcr = false) {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);

    const cache = dataStore.get(TG_CACHE_KEY, {});
    let stat;
    try { stat = fs.statSync(filePath); } catch { return { text: '', drawingNumbers: [], sourceMethod: 'error', error: 'file_not_found' }; }
    const cached = cache[filePath];
    if (cached && cached.mtime === stat.mtimeMs && cached.extractedAt && !cached.error) {
        return {
            text: cached.text || '',
            drawingNumbers: cached.drawingNumbers || [],
            sourceMethod: cached.sourceMethod || 'cache',
            fromCache: true,
        };
    }

    let result;

    if (ext === '.dxf') {
        let text;
        try { text = extractTextFromDxf(filePath); } catch (dxfErr) { text = ''; }
        const numbers = extractDrawingNumbers(text);
        result = {
            text: text.substring(0, 10000),
            drawingNumbers: numbers,
            sourceMethod: numbers.length > 0 ? 'dxf' : 'dxf_no_numbers',
        };
    }

    else if (ext === '.pdf') {
        try {
            const text = await extractTextFromPdf(filePath);
            const numbers = extractDrawingNumbers(text);
            const hasText = text.trim().length > 50;

            if (hasText && numbers.length > 0) {
                result = {
                    text: text.substring(0, 10000),
                    drawingNumbers: numbers,
                    sourceMethod: 'pdf',
                };
            } else if (useOcr) {
                console.log(`  📄 PDF 文字不足 (${fileName})，嘗試 OCR...`);
                const ocrResult = await ocrTgPdf(filePath);
                result = {
                    text: ocrResult.text || text.substring(0, 10000),
                    drawingNumbers: ocrResult.numbers,
                    sourceMethod: ocrResult.sourceMethod,
                };
            } else {
                result = {
                    text: text.substring(0, 10000),
                    drawingNumbers: numbers,
                    sourceMethod: hasText ? 'pdf_no_numbers' : 'pdf_no_text',
                };
            }
        } catch (err) {
            result = {
                text: '',
                drawingNumbers: [],
                sourceMethod: 'pdf_error',
                error: err.message,
            };
        }
    }

    else if (ext === '.dwg') {
        result = {
            text: '',
            drawingNumbers: [],
            sourceMethod: 'dwg_unsupported',
        };
    }

    else {
        result = {
            text: '',
            drawingNumbers: [],
            sourceMethod: 'unsupported_format',
        };
    }

    const latestCache = dataStore.get(TG_CACHE_KEY, {});
    latestCache[filePath] = {
        extractedAt: new Date().toISOString(),
        mtime: stat.mtimeMs,
        text: result.text,
        drawingNumbers: result.drawingNumbers,
        sourceMethod: result.sourceMethod,
        error: result.error || null,
        fileName,
    };
    dataStore.set(TG_CACHE_KEY, latestCache);

    return { ...result, fromCache: false };
}

// === 全域檔案掃描 ===

/**
 * 掃描 POR 目錄，建立全域檔案索引
 * 掃描深度：1 層（預設）或指定深度，超過上限嘅 folder 繼續掃瞄以便發現 TG
 *
 * @param {string} porBasePath
 * @param {number} [maxDepth=1] 掃描深度（0 = 只掃指定目錄本身）
 * @returns {object} 檔案索引
 */
function scanAllFiles(porBasePath, maxDepth = 1) {
    if (!fs.existsSync(porBasePath)) {
        throw new Error(`POR 路徑唔存在: ${porBasePath}`);
    }

    const allFiles = [];
    const tgFiles = [];
    const drawingFiles = [];
    const folderMap = {};
    const numberToFiles = {};

    let scannedFolders = 0;

    /**
     * 掃描一個目錄入面嘅檔案
     */
    function scanDir(dirPath, depth) {
        let entries;
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch {
            return;
        }

        const dirFiles = [];
        const dirTgs = [];
        const dirDrawings = [];
        const subDirs = [];
        const relativeName = path.relative(porBasePath, dirPath) || path.basename(dirPath);

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (depth < maxDepth) {
                    subDirs.push(entry.name);
                }
                continue;
            }

            const ext = path.extname(entry.name).toLowerCase();
            if (NON_DRAWING_EXTS.has(ext)) continue;
            if (ext !== '.pdf' && ext !== '.dwg' && ext !== '.dxf') continue;

            const filePath = path.join(dirPath, entry.name);
            let stat;
            try {
                stat = fs.statSync(filePath);
            } catch {
                continue;
            }
            if (stat.size < 100 && ext !== '.pdf') continue;

            const isTG = /TG/i.test(entry.name) || /位置图/i.test(entry.name) || /位置圖/i.test(entry.name);
            const numbers = extractNumbersFromFileName(entry.name);

            const fileEntry = {
                fileName: entry.name,
                filePath,
                ext,
                size: stat.size,
                isTG,
                numbers,
                folderName: relativeName,
            };

            allFiles.push(fileEntry);
            dirFiles.push(fileEntry);

            if (isTG) {
                tgFiles.push(fileEntry);
                dirTgs.push(fileEntry);
            } else {
                drawingFiles.push(fileEntry);
                dirDrawings.push(fileEntry);
            }

            for (const num of numbers) {
                if (!numberToFiles[num]) numberToFiles[num] = [];
                numberToFiles[num].push({
                    fileName: entry.name,
                    folderName: relativeName,
                    filePath,
                    ext,
                    isTG,
                });
            }
        }

        if (dirFiles.length > 0 || depth === 0) {
            folderMap[relativeName] = {
                folderName: relativeName,
                folderPath: dirPath,
                totalFiles: dirFiles.length,
                tgFiles: dirTgs.map((f) => f.fileName),
                drawingFiles: dirDrawings.map((f) => f.fileName),
            };
        }

        scannedFolders++;

        // 遞迴掃子目錄
        for (const sub of subDirs) {
            scanDir(path.join(dirPath, sub), depth + 1);
        }
    }

    // 執行掃描（從根目錄開始）
    scanDir(porBasePath, 0);

    const registry = {
        scannedAt: new Date().toISOString(),
        porBasePath,
        scannedFolders,
        foldersWithTg: Object.values(folderMap).filter((f) => f.tgFiles.length > 0).length,
        foldersWithDrawings: Object.values(folderMap).filter((f) => f.drawingFiles.length > 0).length,
        tgFileCount: tgFiles.length,
        drawingFileCount: drawingFiles.length,
        folderMap,
        numberToFiles: Object.fromEntries(
            Object.entries(numberToFiles).map(([k, v]) => [k, v])
        ),
    };

    dataStore.set(FILE_INDEX_KEY, registry);
    return registry;
}

// === Folder 處理（用檔案索引） ===

/**
 * 處理單個 Folder：提取 TG 內容，cross-reference 實際加工圖檔案
 *
 * @param {string} folderPath
 * @param {object} [fileRegistry] 可選嘅全域檔案索引，唔傳就自動掃描
 * @param {boolean} [useOcr=false]
 * @returns {Promise<object>}
 */
async function processFolder(folderPath, fileRegistry = null, useOcr = false) {
    let files;
    try { files = fs.readdirSync(folderPath); } catch { return { folder: path.basename(folderPath), files: 0, errors: 1, error: '讀取目錄失敗' }; }
    const tgEntries = [];
    const folderName = path.basename(folderPath);

    // 提取 TG 內容
    for (const file of files) {
        const isTG = /TG/i.test(file) || /位置图/i.test(file) || /位置圖/i.test(file);
        if (!isTG) continue;

        const ext = path.extname(file).toLowerCase();
        if (ext !== '.pdf' && ext !== '.dwg' && ext !== '.dxf') continue;

        const fullPath = path.join(folderPath, file);
        const result = await extractTgContent(fullPath, useOcr);

        tgEntries.push({
            fileName: file,
            ext,
            ...result,
        });
    }

    // 合併 TG 嘅繪圖編號
    const allNumbers = new Set();
    const tgNumberMap = {};
    for (const entry of tgEntries) {
        for (const num of entry.drawingNumbers) {
            allNumbers.add(num);
            if (!tgNumberMap[num]) tgNumberMap[num] = [];
            tgNumberMap[num].push(entry.fileName);
        }
    }

    // Cross-reference：用全域檔案索引尋找對應嘅加工圖檔案
    const registry = fileRegistry || dataStore.get(FILE_INDEX_KEY, null);
    const crossRefs = [];

    for (const num of allNumbers) {
        const referencedFiles = registry?.numberToFiles?.[num] || [];
        // 過濾：只計非 TG 嘅加工圖檔案
        const drawingRefs = referencedFiles.filter((r) => !r.isTG);
        if (drawingRefs.length > 0) {
            crossRefs.push({
                drawingNumber: num,
                foundInFolders: drawingRefs.map((r) => ({
                    folderName: r.folderName,
                    fileName: r.fileName,
                    ext: r.ext,
                })),
            });
        }
    }

    // 尋找 folder 內實際嘅加工圖檔案（非 TG）
    const localDrawings = [];
    for (const file of files) {
        if (/TG/i.test(file) || /位置图/i.test(file) || /位置圖/i.test(file)) continue;
        const ext = path.extname(file).toLowerCase();
        if (NON_DRAWING_EXTS.has(ext)) continue;
        if (ext !== '.pdf' && ext !== '.dwg' && ext !== '.dxf') continue;

        const fullPath = path.join(folderPath, file);
        const stat = fs.statSync(fullPath);
        if (stat.size < 100) continue;

        localDrawings.push({
            fileName: file,
            ext,
            size: stat.size,
            numbers: extractNumbersFromFileName(file),
        });
    }

    const folderResult = {
        folderName,
        folderPath,
        tgCount: tgEntries.length,
        tgFiles: tgEntries,
        localDrawingFiles: localDrawings,
        uniqueDrawingNumbers: [...allNumbers].sort(),
        crossReferences: crossRefs.sort((a, b) => a.drawingNumber.localeCompare(b.drawingNumber)),
        drawingNumberSources: tgNumberMap,
        processedAt: new Date().toISOString(),
    };

    return folderResult;
}

// === 全域掃描 ===

/**
 * 完整掃描：建立全域檔案索引 + 處理所有有 TG 嘅 Folder
 *
 * @param {string} porBasePath
 * @param {boolean} [useOcr=false]
 * @param {number} [fileScanDepth=1] 檔案掃描深度
 * @returns {Promise<{fileRegistry: object, folderResults: Array<object>}>}
 */
async function scanAllFolders(porBasePath, useOcr = false, fileScanDepth = 1) {
    console.log('📂 階段1：掃描所有檔案，建立全域索引...');
    const fileRegistry = scanAllFiles(porBasePath, fileScanDepth);
    console.log(`   找到 ${fileRegistry.drawingFileCount} 個加工圖檔案，${fileRegistry.tgFileCount} 個 TG 檔案`);

    console.log('\n🔍 階段2：提取 TG 內容...');
    const results = [];

    for (const item of Object.keys(fileRegistry.folderMap)) {
        const folderInfo = fileRegistry.folderMap[item];
        if (folderInfo.tgFiles.length === 0) continue;

        console.log(`  📁 ${item.substring(0, 60)}`);
        try {
            const folderResult = await processFolder(folderInfo.folderPath, fileRegistry, useOcr);
            results.push(folderResult);
        } catch (err) {
            console.error(`  ❌ 錯誤: ${err.message}`);
        }
    }

    // 儲存結果
    dataStore.set(TG_INDEX_KEY, {
        scannedAt: new Date().toISOString(),
        folderCount: results.length,
        fileRegistry,
        folders: results,
    });

    // 摘要
    let totalTgNums = 0;
    let totalCrossRefs = 0;
    for (const r of results) {
        totalTgNums += r.uniqueDrawingNumbers.length;
        totalCrossRefs += r.crossReferences.length;
    }

    console.log(`\n✅ 掃描完成`);
    console.log(`   Folder: ${results.length} 個有 TG`);
    console.log(`   TG 提取繪圖編號: ${totalTgNums} 個`);
    console.log(`   Cross-reference 配對: ${totalCrossRefs} 個`);

    return { fileRegistry, folderResults: results };
}

// === 查詢 ===

/**
 * 取得已儲存嘅 TG 索引
 * @returns {object|null}
 */
function getTgIndex() {
    return dataStore.get(TG_INDEX_KEY, null);
}

/**
 * 取得全域檔案索引
 * @returns {object|null}
 */
function getFileRegistry() {
    return dataStore.get(FILE_INDEX_KEY, null);
}

/**
 * 用 Folder 名稱搜尋
 * @param {string} query
 * @returns {Array<object>}
 */
function searchByFolder(query) {
    const index = dataStore.get(TG_INDEX_KEY, null);
    if (!index || !index.folders) return [];

    const q = query.toLowerCase();
    return index.folders
        .filter((f) => f.folderName.toLowerCase().includes(q))
        .map((f) => ({
            folderName: f.folderName,
            drawingNumbers: f.uniqueDrawingNumbers,
            crossReferences: f.crossReferences,
            tgFiles: f.tgFiles.map((t) => t.fileName),
            tgCount: f.tgCount,
        }));
}

/**
 * 用繪圖編號搜尋
 * @param {string} drawingNumber
 * @returns {Array<object>}
 */
function searchByDrawingNumber(drawingNumber) {
    const index = dataStore.get(TG_INDEX_KEY, null);
    if (!index || !index.folders) return [];

    const cleanNum = drawingNumber.replace(/[-_]/g, '').toUpperCase();
    return index.folders
        .filter((f) => f.uniqueDrawingNumbers.includes(cleanNum))
        .map((f) => ({
            folderName: f.folderName,
            crossReferences: f.crossReferences.filter((r) => r.drawingNumber === cleanNum),
            tgFiles: f.drawingNumberSources[cleanNum] || [],
        }));
}

/**
 * 產生摘要報告
 * @returns {string}
 */
function generateSummary() {
    const index = dataStore.get(TG_INDEX_KEY, null);
    if (!index || !index.folders) return '⚠️ 未有索引資料，請先執行 scanAllFolders()';

    const lines = [];
    lines.push(`📊 TG 索引摘要（${new Date(index.scannedAt).toLocaleString('zh-HK')}）`);
    lines.push('─'.repeat(50));
    lines.push(`Folder 總數: ${index.folderCount}`);
    lines.push(`檔案索引: ${index.fileRegistry?.drawingFileCount || 0} 加工圖, ${index.fileRegistry?.tgFileCount || 0} TG`);

    let totalTgNums = 0;
    let totalCrossRefs = 0;
    const methodCounts = {};

    for (const f of index.folders) {
        totalTgNums += f.uniqueDrawingNumbers.length;
        totalCrossRefs += f.crossReferences.length;

        for (const tg of f.tgFiles) {
            const m = tg.sourceMethod || 'unknown';
            methodCounts[m] = (methodCounts[m] || 0) + 1;
        }

        const crossRate = f.uniqueDrawingNumbers.length > 0
            ? Math.round((f.crossReferences.length / f.uniqueDrawingNumbers.length) * 100)
            : 0;
        lines.push(`\n📁 ${f.folderName.substring(0, 58)}`);
        lines.push(`   TG:${f.tgCount} 編號:${f.uniqueDrawingNumbers.length} 配對:${f.crossReferences.length}(${crossRate}%)`);
    }

    lines.push('\n' + '─'.repeat(50));
    lines.push(`總計: ${totalTgNums} 繪圖編號, ${totalCrossRefs} cross-reference 配對`);
    lines.push('\n提取方法:');
    for (const [method, count] of Object.entries(methodCounts).sort((a, b) => b[1] - a[1])) {
        lines.push(`   ${method}: ${count}`);
    }

    return lines.join('\n');
}

module.exports = {
    extractDrawingNumbers,
    extractNumbersFromFileName,
    extractTextFromDxf,
    extractTextFromPdf,
    ocrTgPdf,
    extractTgContent,
    scanAllFiles,
    processFolder,
    scanAllFolders,
    getTgIndex,
    getFileRegistry,
    searchByFolder,
    searchByDrawingNumber,
    generateSummary,
};
