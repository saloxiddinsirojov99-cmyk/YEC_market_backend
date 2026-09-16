const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL topilmadi. backend/.env faylini tekshiring.');
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const manifestPath = path.join(
  __dirname,
  '..',
  '..',
  'front',
  'public',
  'images',
  'collections',
  'manifest.json',
);

if (!fs.existsSync(manifestPath)) {
  throw new Error(`Manifest topilmadi: ${manifestPath}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

const sizeOptions = [
  { label: '300x400', width: 300, height: 400 },
  { label: '300x500', width: 300, height: 500 },
  { label: '350x500', width: 350, height: 500 },
  { label: '400x500', width: 400, height: 500 },
  { label: '400x600', width: 400, height: 600 },
  { label: '450x600', width: 450, height: 600 },
  { label: '500x700', width: 500, height: 700 },
  { label: '500x800', width: 500, height: 800 },
];

const patternByCollection = {
  steffano: 'Neo Clasica',
  antique: 'Classic',
  'iran-soft': 'Premium',
  trio: 'Modern',
  luna: 'Minimal',
  etalon: 'Neo Clasica',
  zenit: 'Modern',
  terra: 'Classic',
  orlando: 'Modern',
  zeugma: 'Oriental',
  verona: 'Classic',
  fendi: 'Neo Clasica',
  touch: 'Modern',
  mardin: 'Classic',
};

const materialByCollection = {
  steffano: 'Paxta',
  antique: 'Paxta + akril',
  'iran-soft': 'Eron akril',
  trio: 'Akril',
  luna: 'Paxta',
  etalon: 'Akril',
  zenit: 'Akril',
  terra: 'Paxta + akril',
  orlando: 'Akril',
  zeugma: 'Akril',
  verona: 'Paxta',
  fendi: 'Ipak + akril',
  touch: 'Paxta + akril',
};

const descriptionTemplates = [
  'YEC korxonasining Eron texnologiyasida 1200 taroq va 3 000 000 zichlikda ishlab chiqarilgan premium gilami. Yumshoq, chidamli va uzoq xizmat qiladi.',
  "Eron texnologiyasidagi premium to'quv, 1200 taroq va 3 000 000 zichlik. Oson tozalanadi va kundalik foydalanish uchun qulay.",
  "YEC mahsuloti: Eron texnologiyasi, 1200 taroq, 3 000 000 zichlik. Nafis naqsh va ranglar bilan interyerni boyitadi.",
];

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

const randomInt = (min, max, step = 1000) => {
  const span = Math.floor((max - min) / step);
  const value = min + step * Math.floor(Math.random() * (span + 1));
  return value;
};

const formatName = (collectionName, code) => `${collectionName} ${code}`;

async function ensureCategories() {
  const uniquePatterns = Array.from(
    new Set(Object.values(patternByCollection)),
  );
  const categoryMap = new Map();

  for (const pattern of uniquePatterns) {
    const category = await prisma.category.upsert({
      where: { name: pattern },
      update: {},
      create: { name: pattern },
    });
    categoryMap.set(pattern, category.id);
  }

  return categoryMap;
}

async function main() {
  const categoryMap = await ensureCategories();
  let createdCount = 0;
  let skippedCount = 0;

  for (const collection of manifest.collections) {
    const slug = collection.slug;
    const collectionName = collection.name;
    const images = manifest.images?.[slug] || {};

    const pattern = patternByCollection[slug] || 'Neo Clasica';
    const material = manifest.materials?.[slug] || materialByCollection[slug] || 'Paxta + akril';
    const categoryId = categoryMap.get(pattern);

    for (const [code, imageUrl] of Object.entries(images)) {
      const name = formatName(collectionName, code);
      const existing = await prisma.carpet.findFirst({
        where: { name },
        select: { id: true },
      });

      if (existing) {
        skippedCount += 1;
        continue;
      }

      const size = pickRandom(sizeOptions);
      const area = (size.width * size.height) / 10000;
      const pricePerM2 = randomInt(58000, 550000, 1000);
      const totalPrice = Math.round((pricePerM2 * area) / 1000) * 1000;
      const stock = randomInt(1, 4, 1);
      const descriptionBase = pickRandom(descriptionTemplates);
      const description = `${descriptionBase} Guli: ${pattern}. Material: ${material}.`;

      await prisma.carpet.create({
        data: {
          name,
          price: totalPrice,
          stock,
          size: size.label,
          material,
          description,
          categoryId,
          images: [imageUrl],
        },
      });

      createdCount += 1;
    }
  }

  console.log(`Tayyor: ${createdCount} ta yangi gilam qo'shildi, ${skippedCount} ta o'tkazib yuborildi.`);
}

main()
  .catch((error) => {
    console.error('Seed xatosi:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
