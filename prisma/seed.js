require('dotenv').config();

const { PrismaClient, UserRole } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcrypt');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL topilmadi. .env faylini tekshiring.');
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@yecmarket.uz';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existing) {
    console.log(`Admin allaqachon mavjud: ${adminEmail}`);
  } else {
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    await prisma.user.create({
      data: {
        name: 'System Admin',
        email: adminEmail,
        phone: '+998900000000',
        password: hashedPassword,
        role: UserRole.ADMIN,
      },
    });

    console.log(`Admin yaratildi: ${adminEmail}`);
  }

  // Seed RecommendationSettings
  const recSettings = await prisma.recommendationSettings.findUnique({
    where: { id: 'singleton' },
  });
  if (!recSettings) {
    await prisma.recommendationSettings.create({
      data: {
        id: 'singleton',
        roomWeight: 0.35,
        clearanceWeight: 0.25,
        colorWeight: 0.15,
        styleWeight: 0.10,
        fifoWeight: 0.10,
        popularityWeight: 0.05,
      },
    });
    console.log('RecommendationSettings seeded.');
  }

  // Seed AiSettings
  const aiSettings = await prisma.aiSettings.findUnique({
    where: { id: 'singleton' },
  });
  if (!aiSettings) {
    await prisma.aiSettings.create({
      data: {
        id: 'singleton',
        provider: 'OPENAI',
        imageQuality: 'standard',
        maxResolution: 2048,
        dailyGuestLimit: 0,
        dailyUserLimit: 5,
        dailyVipLimit: 20,
        aiEnabled: true,
      },
    });
    console.log('AiSettings seeded.');
  }

  // Seed DepositTier
  const tiersCount = await prisma.depositTier.count();
  if (tiersCount === 0) {
    const tiers = [
      { minAmount: 0, maxAmount: 1000000, percent: 30 },
      { minAmount: 1000001, maxAmount: 3000000, percent: 25 },
      { minAmount: 3000001, maxAmount: 7000000, percent: 20 },
      { minAmount: 7000001, maxAmount: 15000000, percent: 15 },
      { minAmount: 15000001, maxAmount: 99999999, percent: 10 },
    ];
    for (const tier of tiers) {
      await prisma.depositTier.create({ data: tier });
    }
    console.log('DepositTiers seeded.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
