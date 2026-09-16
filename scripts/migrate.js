require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const PRICE_MAP = {
  'iran-soft': 370000,
  'luna': 58300,
  'zeugma': 143100,
  'zenit': 182300,
  'touch': 198700,
  'verona': 296800,
  'steffano': 265000,
  'etalon': 99100,
  'terra': 141000,
  'orlando': 140000,
  'trio': 160000,
  'fendi': 75000,
  'antiquare': 210000,
};

function calculateArea(size) {
  try {
    const cleaned = size.toLowerCase().replace(/\s+/g, '').replace(/[x*]/g, 'x');
    const matches = cleaned.match(/(\d+(\.\d+)?)/g);
    if (matches && matches.length >= 2) {
      const w = parseFloat(matches[0]);
      const h = parseFloat(matches[1]);
      return w * h;
    }
  } catch (e) {}
  return 0;
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL topilmadi. .env faylini tekshiring.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('--- Starting Migration ---');

  const carpets = await prisma.carpet.findMany();
  console.log(`Checking ${carpets.length} carpets...`);

  let updatedPriceCount = 0;
  for (const carpet of carpets) {
    const nameLower = carpet.name.toLowerCase();
    let m2Price = 0;

    for (const [key, price] of Object.entries(PRICE_MAP)) {
      if (nameLower.includes(key)) {
        m2Price = price;
        break;
      }
    }

    if (m2Price > 0) {
      const area = calculateArea(carpet.size);
      if (area > 0) {
        const newTotalPrice = Math.round(m2Price * area);
        await prisma.carpet.update({
          where: { id: carpet.id },
          data: { price: newTotalPrice.toString() },
        });
        updatedPriceCount++;
      }
    }
  }
  console.log(`Updated prices for ${updatedPriceCount} carpets.`);

  const allCategories = await prisma.category.findMany();
  const validCategoryNames = ['Modern', 'Classic', 'Oriental', 'Neo Clasica', 'Minimal', 'Premium', 'Joynamoz'];
  
  const validMap = new Map();
  allCategories.forEach(c => {
    validMap.set(c.name.toLowerCase(), c);
  });

  const modernCat = validMap.get('modern');
  const classicCat = validMap.get('classic');

  if (!modernCat || !classicCat) {
    console.error('Modern or Classic category not found! Aborting category cleanup.');
    return;
  }

  const categoriesToDelete = allCategories.filter(c => {
    const nameLower = c.name.toLowerCase();
    return !validCategoryNames.some(v => v.toLowerCase() === nameLower);
  });

  console.log(`Cleaning up ${categoriesToDelete.length} redundant categories...`);

  for (const oldCat of categoriesToDelete) {
    const targetCat = modernCat; // Default to Modern
    const moved = await prisma.carpet.updateMany({
      where: { categoryId: oldCat.id },
      data: { categoryId: targetCat.id },
    });
    console.log(`Moved ${moved.count} carpets from "${oldCat.name}" to "${targetCat.name}"`);
    
    try {
      await prisma.category.delete({ where: { id: oldCat.id } });
      console.log(`Deleted category "${oldCat.name}"`);
    } catch (e) {
      console.error(`Skipped deleting occupied category "${oldCat.name}"`);
    }
  }

  console.log('--- Migration Finished ---');
}

main()
  .catch(e => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
