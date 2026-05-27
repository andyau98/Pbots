const path = require('path');
const { getDatabase } = require(path.join(process.cwd(), 'src/core/database'));
const db = getDatabase();
const s = db.getTgMappingStats();
const c = db.getTgCacheStats();
console.log('tg_mapping:', JSON.stringify(s, null, 2));
console.log('tg_cache:', JSON.stringify(c, null, 2));
const dwgHasTag = db.db.prepare("SELECT COUNT(*) as c FROM files WHERE has_tag = 1 AND ext = '.dwg'").get().c;
console.log('has_tag DWG total:', dwgHasTag);
