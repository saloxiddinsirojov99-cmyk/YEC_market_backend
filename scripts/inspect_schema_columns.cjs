const { Pool } = require('pg');
require('dotenv').config({ path: 'd:/YEC_SOLD/backend/.env' });

async function check() {
  const url = process.env.DATABASE_URL.trim().replace(/^["']|["']$/g, '');
  const pool = new Pool({
    connectionString: url,
    ssl: url.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
  });

  try {
    const res = await pool.query(`
      SELECT barcode, sku, size, "inventoryStatus" 
      FROM "inventory_items" 
      LIMIT 10;
    `);
    console.log('\n=== Sample inventory_items barcodes ===');
    console.log(res.rows);

    const zeroBarcodes = await pool.query(`
      SELECT barcode, sku, size 
      FROM "inventory_items" 
      WHERE barcode LIKE '0%' 
      LIMIT 5;
    `);
    console.log('\n=== Barcodes starting with 0 count ===');
    const zeroCount = await pool.query(`SELECT COUNT(*) FROM "inventory_items" WHERE barcode LIKE '0%';`);
    console.log('Count:', zeroCount.rows[0].count);
    if (zeroBarcodes.rows.length > 0) {
      console.log('Sample zero barcodes:', zeroBarcodes.rows);
    }

    const indexes = await pool.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename IN ('carpets', 'inventory_items', 'roll_inventories', 'basko_sync_logs');
    `);
    console.log('\n=== Existing Indexes ===');
    for (const idx of indexes.rows) {
      console.log(`  - ${idx.indexname}: ${idx.indexdef}`);
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

check();
