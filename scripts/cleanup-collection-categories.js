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

const normalize = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const collectionIndex = new Map();
for (const collection of manifest.collections || []) {
  if (!collection?.slug || !collection?.name) continue;
  collectionIndex.set(normalize(collection.slug), collection.slug);
  collectionIndex.set(normalize(collection.name), collection.slug);
}

collectionIndex.set('touchblue', 'touch');
collectionIndex.set('touchwhite', 'touch');

const collectionKeys = Array.from(collectionIndex.keys()).sort(
  (a, b) => b.length - a.length,
);

const findCollectionSlug = (categoryName) => {
  const normalized = normalize(categoryName);
  if (collectionIndex.has(normalized)) {
    return collectionIndex.get(normalized);
  }

  for (const key of collectionKeys) {
    if (normalized.includes(key)) {
      return collectionIndex.get(key);
    }
  }

  return null;
};

async function ensureCategoryIds() {
  const patternNames = Array.from(
    new Set(Object.values(patternByCollection)),
  );
  const categoryMap = new Map();

  for (const pattern of patternNames) {
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
  const categoryMap = await ensureCategoryIds();
  const categories = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { carpets: true } } },
  });

  const targets = categories
    .map((category) => {
      const slug = findCollectionSlug(category.name);
      if (!slug) return null;
      const pattern = patternByCollection[slug] || 'Neo Clasica';
      return { category, slug, pattern };
    })
    .filter(Boolean);

  if (targets.length === 0) {
    console.log('Hech qanday gilam nomli tur topilmadi.');
    return;
  }

  for (const { category, slug, pattern } of targets) {
    const targetId = categoryMap.get(pattern);

    if (!targetId) {
      console.warn(`Target topilmadi: ${pattern}. ${category.name} o'tkazib yuborildi.`);
      continue;
    }

    const updated = await prisma.carpet.updateMany({
      where: { categoryId: category.id },
      data: { categoryId: targetId },
    });

    await prisma.category.delete({ where: { id: category.id } });

    console.log(
      `${category.name} (${slug}) o'chirildi. ${updated.count} ta gilam -> ${pattern}.`,
    );
  }
}

main()
  .catch((error) => {
    console.error('Cleanup xatosi:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
