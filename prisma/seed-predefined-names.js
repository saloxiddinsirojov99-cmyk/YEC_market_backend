require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Starting to seed predefined carpet names from existing physical carpets...");

  const carpets = await prisma.carpet.findMany({
    select: {
      name: true,
      designCode: true,
      images: true,
      category: {
        select: { name: true }
      }
    }
  });

  console.log(`Found ${carpets.length} physical carpets in DB.`);

  let createdCount = 0;
  let skippedCount = 0;

  for (const c of carpets) {
    const name = c.name.trim();
    if (!name) continue;

    // Check if predefined CarpetName already exists
    const existing = await prisma.carpetName.findUnique({
      where: { name }
    });

    if (existing) {
      skippedCount++;
      continue;
    }

    // Determine design code
    const designCode = c.designCode || name.replace(/[^A-Za-z0-9]+/g, '');

    // Determine images
    let images = c.images || [];
    if (images.length === 0) {
      const collectionFolder = c.category?.name || "Verona";
      // Construct catalog.yec.uz URL
      images = [`https://catalog.yec.uz/media/photos/collections/${collectionFolder}/${name}.jpg`];
    }

    await prisma.carpetName.create({
      data: {
        name,
        designCode,
        images
      }
    });

    createdCount++;
  }

  console.log(`Seeding complete. Created ${createdCount} predefined names, skipped ${skippedCount} duplicates.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
