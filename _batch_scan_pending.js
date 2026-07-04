/**
 * 一次性補掃所有 pending TG DWG 檔案
 * - 每個檔案 scan 後必定寫 tg_cache（包括空內容），防止死鎖
 * - 有 drawing_numbers 嘅同時寫 tg_mapping
 * - scan 緊嘅狀態透過 _deepscanProgress 即時更新
 */
const path = require('path');
const fs = require('fs');
const { getDatabase } = require('./src/core/database');
const { extractTextArrayFromDwg } = require('./tools/dwgReader');

const drawingSearch = require('./skills/drawingSearch');
const db = getDatabase();

// 直接使用主程式嘅 extractDrawingNumbers，確保邏輯一致
const extractDrawingNumbers = drawingSearch.extractDrawingNumbers;

async function main() {
    // Load index
    drawingSearch.loadIndex();
    const dp = drawingSearch.deepscanProgress;

    // Find all pending
    const fileOrder = dp.fileOrder || [];
    const fileDetails = dp.fileDetails || {};
    const pendingPaths = fileOrder.filter(fp => {
        const fd = fileDetails[fp];
        return fd && fd.status === 'pending';
    });

    console.log(`\n📊 共 ${pendingPaths.length} 個 pending 檔案要掃描`);
    if (pendingPaths.length === 0) {
        console.log('✅ 冇 pending 檔案');
        process.exit(0);
    }

    let scanned = 0, cachedHit = 0, errorCount = 0, withNumbers = 0, emptyCount = 0;

    for (let i = 0; i < pendingPaths.length; i++) {
        const fpath = pendingPaths[i];
        const fd = fileDetails[fpath];
        if (!fd) continue;

        const pct = Math.round((i + 1) / pendingPaths.length * 100);
        process.stdout.write(`\r[${i+1}/${pendingPaths.length} ${pct}%] ${fd.name.substring(0, 50).padEnd(52)}`);

        try {
            const stat = fs.statSync(fpath);
            fd.size = stat.size;

            // mtime 快取檢查
            const cached = db.getTgCache(fpath);
            const isFresh = cached && cached.drawing_numbers && cached.drawing_numbers !== '[]'
                && Math.abs(Number(cached.mtime) - stat.mtimeMs) < 1;

            let numbers = [];
            if (isFresh) {
                numbers = JSON.parse(cached.drawing_numbers);
                fd.status = 'cached';
                fd.numbers = numbers;
                cachedHit++;
            } else {
                const texts = await extractTextArrayFromDwg(fpath, 60000);
                const allText = texts.join(' ');
                numbers = extractDrawingNumbers(allText.toUpperCase());

                // ✅ 無論有冇 numbers 都寫 tg_cache
                db.setTgCache(fpath, {
                    drawing_numbers: JSON.stringify(numbers),
                    source_method: 'batch_fix',
                    mtime: stat.mtimeMs,
                });
                scanned++;
                fd.status = (numbers.length > 0) ? 'done' : 'done_empty';
                fd.numbers = numbers;
                if (numbers.length > 0) withNumbers++; else emptyCount++;
            }

            if (numbers.length > 0) {
                const now = new Date().toISOString();
                const batchMappings = [];
                for (const num of numbers) {
                    batchMappings.push({ drawing_number: num, file_path: fpath, dwg_path: fpath, updated_at: now });
                }
                const pdfPath = fpath.replace(/\.dwg$/i, '.pdf');
                if (fs.existsSync(pdfPath)) {
                    for (const num of numbers) {
                        batchMappings.push({ drawing_number: num, file_path: pdfPath, dwg_path: fpath, updated_at: now });
                    }
                }
                db.insertTgMapping(batchMappings);
            }
        } catch (err) {
            errorCount++;
            fd.status = 'error';
            fd.error = err.message.substring(0, 200);
            // 即使 error 都寫空 cache 防重掃
            try {
                db.setTgCache(fpath, {
                    drawing_numbers: '[]',
                    source_method: 'error_fallback',
                    mtime: (fd.size > 0) ? Date.now() : Date.now(),
                });
            } catch {}
        }
    }

    console.log('\n\n=== 掃描完成 ===');
    console.log(`總數: ${pendingPaths.length}`);
    console.log(`新掃描: ${scanned} (有編號: ${withNumbers}, 空: ${emptyCount})`);
    console.log(`快取命中: ${cachedHit}`);
    console.log(`錯誤: ${errorCount}`);

    const stats = db.getTgMappingStats();
    const cacheStats = db.getTgCacheStats();
    console.log(`\ntg_mapping: ${stats.total} 條, ${stats.files} 個檔案`);
    console.log(`tg_cache: ${cacheStats.total} 條, 有內容: ${cacheStats.with_content}`);

    // 重新載入進度
    setTimeout(() => {
        // Trigger restore from DB to update UI progress
        drawingSearch.restoreProgressFromDb();
        process.exit(0);
    }, 1000);
}

main().catch(err => { console.error(err); process.exit(1); });
