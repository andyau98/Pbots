/**
 * Deep Scan：完整重建 tg_mapping 索引
 * 可以背景執行，唔會影響主程式
 */
const path = require('path');
const config = require(path.join(process.cwd(), 'configs/settings.json'));
const drawingSearch = require(path.join(process.cwd(), 'skills/drawingSearch'));

const porPath = config.paths.por;
console.log('='.repeat(60));
console.log('Deep Scan TG Mapping 開始');
console.log('POR 目錄:', porPath);
console.log('開始時間:', new Date().toLocaleString('zh-HK'));
console.log('='.repeat(60));

drawingSearch.rebuildTgMapping(porPath)
    .then(result => {
        console.log('='.repeat(60));
        console.log('Deep Scan 完成');
        console.log('完成時間:', new Date().toLocaleString('zh-HK'));
        console.log(JSON.stringify(result, null, 2));
        console.log('='.repeat(60));
    })
    .catch(err => {
        console.error('Deep Scan 失敗:', err);
        process.exit(1);
    });
