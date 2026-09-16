import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const prisma = new PrismaClient();

const PRICE_MAP: Record<string, number> = {
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

function calculateArea(size: string): number {
  try {
    // Expected formats: "3x4", "3 x 4", "3.5x4.5", "3*4"
    const cleaned = size.toLowerCase().replace(/\s+/g, '').replace(/[x*]/g, 'x');
    const [w, h] = cleaned.split('x').map(Number);
    if (!isNaN(w) && !isNaN(h)) {
      return w * h;
    }
  } catch (e) {
    console.warn(`Failed to parse size: ${size}`);
  }
  return 0;
}

async function main() {
  console.log('--- Starting Migration ---');

  const carpets = await prisma.carpet.findMany({
    include: { category: true },
  });

  console.log(`Found ${carpets.length} carpets.`);

  let updatedCount = 0;
  for (const carpet of carpets) {
    const nameLower = carpet.name.toLowerCase();
    let m2Price = 0;

    // Direct match or partial match from PRICE_MAP
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
          data: { price: newTotalPrice },
        });
        updatedCount++;
        // console.log(`Updated ${carpet.name}: Size=${carpet.size}, Area=${area}, NewPrice=${newTotalPrice}`);
      } else {
        console.warn(`Skipping ${carpet.name} due to invalid area calculation from size: ${carpet.size}`);
      }
    }
  }

  console.log(`Updated prices for ${updatedCount} carpets.`);

  // --- Category Cleanup ---
  // The user wants to remove categories like "Verona", "Mardin" (collection names) 
  // and keep broad ones like "Modern", "Classic", "Oriental", "Neo Clasica", "Minimal", "Premium".
  
  const allCategories = await prisma.category.findMany();
  const validCategoryNames = ['Modern', 'Classic', 'Oriental', 'Neo Clasica', 'Minimal', 'Premium'];
  
  const validMap = new Map(validCategoryNames.map(name => [name.toLowerCase(), allCategories.find(c => c.name.toLowerCase() === name.toLowerCase())]));

  // Ensure all valid categories exist, if not we might need to create them or skip
  for (const [name, cat] of validMap.entries()) {
    if (!cat) {
      console.warn(`Target category "${name}" not found in database!`);
    }
  }

  // Find categories to delete (those that are not in valid names and are collection-like)
  const categoriesToDelete = allCategories.filter(c => {
    const nameLower = c.name.toLowerCase();
    return !validCategoryNames.some(v => v.toLowerCase() === nameLower) && 
           (nameLower.includes('verona') || nameLower.includes('mardin') || nameLower.includes('mandarin') || nameLower.includes(' collezione'));
  });

  console.log(`Found ${categoriesToDelete.length} categories to cleanup.`);

  for (const oldCat of categoriesToDelete) {
    // Move carpets to "Modern" or "Classic" as fallback
    // For now, let's pick "Modern" as the most common fallback if we can find it
    const targetCat = validMap.get('modern') || validMap.get('classic');
    
    if (targetCat) {
      const moved = await prisma.carpet.updateMany({
        where: { categoryId: oldCat.id },
        data: { categoryId: targetCat.id },
      });
      console.log(`Moved ${moved.count} carpets from "${oldCat.name}" to "${targetCat.name}"`);
      
      // Delete empty category
      await prisma.category.delete({ where: { id: oldCat.id } });
      console.log(`Deleted category "${oldCat.name}"`);
    } else {
       console.error(`Cannot clean up "${oldCat.name}" because no suitable target category (Modern/Classic) was found.`);
    }
  }

  console.log('--- Migration Finished ---');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
