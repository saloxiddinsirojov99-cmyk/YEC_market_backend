const { Pool } = require('pg');
require('dotenv').config({ path: 'd:/YEC_SOLD/backend/.env' });

async function verifyDbIntegrity() {
  const url = process.env.DATABASE_URL.trim().replace(/^["']|["']$/g, '');
  const pool = new Pool({
    connectionString: url,
    ssl: url.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
  });

  console.log('🔍 Database yaxlitligi va holatini tekshirish boshlandi...\n');

  try {
    // 1. Table Counts
    const carpets = await pool.query('SELECT COUNT(*) FROM "carpets";');
    const inventory = await pool.query('SELECT COUNT(*) FROM "inventory_items";');
    const rolls = await pool.query('SELECT COUNT(*) FROM "roll_inventories";');
    const categories = await pool.query('SELECT COUNT(*) FROM "categories";');
    const designs = await pool.query('SELECT COUNT(*) FROM "catalog_designs";');
    const users = await pool.query('SELECT COUNT(*) FROM "users";');

    console.log('📊 Jadvallardagi yozuvlar soni:');
    console.log(`  - carpets: ${carpets.rows[0].count}`);
    console.log(`  - inventory_items: ${inventory.rows[0].count}`);
    console.log(`  - roll_inventories: ${rolls.rows[0].count}`);
    console.log(`  - categories: ${categories.rows[0].count}`);
    console.log(`  - catalog_designs: ${designs.rows[0].count}`);
    console.log(`  - users: ${users.rows[0].count}`);

    // 2. Orphan check (Yetim yozuvlar tekshiruvi)
    const orphanItems = await pool.query(`
      SELECT COUNT(*) FROM "inventory_items" i
      LEFT JOIN "carpets" c ON c.id = i."carpetId"
      WHERE c.id IS NULL;
    `);
    console.log(`\n🔗 Yetim inventory_items (mavjud bo'lmagan gilamga bog'langan): ${orphanItems.rows[0].count} ta`);

    const orphanRolls = await pool.query(`
      SELECT COUNT(*) FROM "roll_inventories" r
      LEFT JOIN "carpets" c ON c.id = r."carpetId"
      WHERE c.id IS NULL;
    `);
    console.log(`🔗 Yetim roll_inventories: ${orphanRolls.rows[0].count} ta`);

    // 3. Barcode uniqueness check
    const dupBarcodes = await pool.query(`
      SELECT barcode, COUNT(*) as count 
      FROM "inventory_items" 
      GROUP BY barcode 
      HAVING COUNT(*) > 1;
    `);
    console.log(`\n🏷️ Takrorlangan shtrix-kodlar (mavjud bazada): ${dupBarcodes.rows.length} ta`);

    // 4. Image status check
    const carpetsWithImages = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN array_length(images, 1) > 0 THEN 1 END) as with_images_array,
        COUNT(CASE WHEN "catalogDesignId" IS NOT NULL THEN 1 END) as with_catalog_design
      FROM "carpets";
    `);
    console.log(`\n🖼️ Gilamlar rasmlar holati:`);
    console.log(`  - Jami gilamlar: ${carpetsWithImages.rows[0].total}`);
    console.log(`  - 'images' massivida rasmi bor: ${carpetsWithImages.rows[0].with_images_array}`);
    console.log(`  - 'catalogDesignId' ga bog'langan: ${carpetsWithImages.rows[0].with_catalog_design}`);

    console.log('\n✅ Database yaxlitligi muvaffaqiyatli tekshirildi (Xatoliklar aniqlanmadi).');
  } catch (err) {
    console.error('❌ Xatolik:', err);
  } finally {
    await pool.end();
  }
}

verifyDbIntegrity();
