import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { seedOrganization } from '@/lib/seed-data';
import { DEMO_COOKIE, isDemoSessionEnabled, verifyDemoToken, type DemoRole } from '@/lib/demo-session';

export { DEMO_COOKIE, createDemoToken, isDemoSessionEnabled } from '@/lib/demo-session';
export { DEMO_ROLES, type DemoRole } from '@/lib/demo-types';

export async function currentDemoRole() {
  const cookieJar = await cookies();
  return verifyDemoToken(cookieJar.get(DEMO_COOKIE)?.value);
}

export async function provisionDemoRole(role: DemoRole) {
  if (!isDemoSessionEnabled()) throw new Error('DEMO_LOGIN_DISABLED');
  const organization = await db.organization.upsert({
    where: { slug: 'stocksense-local-demo' },
    create: { name: 'StockSense Demo Workspace', slug: 'stocksense-local-demo', maxUsers: 10, maxWarehouses: 2 },
    update: { maxUsers: 10, maxWarehouses: 2 },
  });

  await db.$transaction(async (tx) => {
    for (const demoRole of ['admin', 'manager', 'staff'] as const) {
      const email = `${demoRole}@stocksense.local`;
      await tx.user.upsert({
        where: { clerkId: `stocksense_demo_${demoRole}` },
        create: { clerkId: `stocksense_demo_${demoRole}`, email, firstName: `Demo ${demoRole[0].toUpperCase()}${demoRole.slice(1)}`, lastName: 'User', role: demoRole, organizationId: organization.id },
        update: { email, role: demoRole, status: 'active', deletedAt: null, organizationId: organization.id },
      });
    }
    await seedOrganization(tx, organization.id);
  });

  const actor = await getDemoActor(role);
  if (!actor) throw new Error('DEMO_USER_UNAVAILABLE');
  return actor;
}

export async function getDemoActor(role: DemoRole) {
  if (!isDemoSessionEnabled()) throw new Error('DEMO_LOGIN_DISABLED');
  const actor = await db.user.findUnique({ where: { clerkId: `stocksense_demo_${role}` }, include: { organization: true } });
  if (!actor || actor.status !== 'active' || actor.deletedAt) throw new Error('DEMO_USER_UNAVAILABLE');
  return actor;
}
