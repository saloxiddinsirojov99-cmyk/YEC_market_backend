require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL topilmadi.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const CARPET_UPDATES = [
  { name: 'iran-soft', price: 370000, desc: 'YEC korxonasining Eron texnologiyasida 1200 taroq va 3 000 000 zichlikda ishlab chiqarilgan premium gilami. Yumshoq, chidamli va uzoq xizmat qiladi. Guli: Classic.' },
  { name: 'touch', price: 198700, desc: 'YEC Touch - teginishda misli ko\'rilmagan yumshoqlikni his eting. Zamonaviy dizayn va yuqori sifatli materiallardan tayyorlangan.' },
  { name: 'verona', price: 245000, desc: 'Verona seriyasi - Italiya nafosati va o\'zbek an\'analarining uyg\'unligi. Chidamliligi bilan ajralib turadi.' },
  { name: 'silk', price: 850000, desc: 'Haqiqiy ipak gilamlar. Noziklik va hashmatni sevuvchilar uchun ideal tanlov.' },
  { name: 'bamboo', price: 320000, desc: 'Bambuk tolasidan tayyorlangan ekologik toza gilamlar. Anti-allergik va juda yumshoq.' },
  { name: 'classic', price: 150000, desc: 'Abadiy klassika. Har qanday xonadonga mo\'ljallangan chidamli va hamyonbop variant.' },
];

async function main() {
  console.log('🔄 Updating carpets...');
  
  const allCarpets = await prisma.carpet.findMany();
  
  for (const carpet of allCarpets) {
    const update = CARPET_UPDATES.find(u => carpet.name.toLowerCase().includes(u.name.toLowerCase()));
    
    let newPrice = carpet.price;
    let newDesc = carpet.description;
    
    if (update) {
      newPrice = update.price;
      newDesc = update.desc;
    } else {
      newDesc = `YEC korxonasining yuqori sifatli ${carpet.name} gilami. Chidamlilik va qulaylikni ta'minlaydi.`;
    }

    await prisma.carpet.update({
      where: { id: carpet.id },
      data: {
        price: newPrice,
        description: newDesc,
      }
    });
    console.log(`✅ Updated: ${carpet.name}`);
  }
  
  console.log('✨ All carpets updated!');
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
