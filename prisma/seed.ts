import { PrismaClient } from '@prisma/client';
import { seedOrganization } from '../lib/seed-data';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) {
    throw new Error('Set SEED_ADMIN_EMAIL to the Clerk email used for your first sign-in, then run npm run db:seed.');
  }
  const user = await prisma.user.findFirst({ where: { email, status: 'active', deletedAt: null }, include: { organization: true } });
  if (!user) {
    throw new Error(`No active StockSense account found for ${email}. Sign up at /sign-up first, then run npm run db:seed.`);
  }
  await prisma.$transaction((tx) => seedOrganization(tx, user.organizationId));
  console.log(`Sample catalog, suppliers, warehouses and opening stock are ready in ${user.organization.name}.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
