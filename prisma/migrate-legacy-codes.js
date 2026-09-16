require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set in env.');
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const carpets = await prisma.carpet.findMany({
    where: {
      OR: [
        { qo_shimchaKod: null },
        { qo_shimchaKod: '' }
      ]
    }
  });

  console.log(`Found ${carpets.length} carpets without qo_shimchaKod.`);

  for (let i = 0; i < carpets.length; i++) {
    const carpet = carpets[i];
    // Generate a unique legacy code based on ID or index
    const code = `LEGACY_${Date.now()}_${i}`;
    await prisma.carpet.update({
      where: { id: carpet.id },
      data: { qo_shimchaKod: code }
    });
  }

  console.log('Migration completed successfully.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
