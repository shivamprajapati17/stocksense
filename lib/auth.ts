import { auth, currentUser } from '@clerk/nextjs/server';
import { currentDemoRole, getDemoActor } from '@/lib/demo-auth';
import { db } from '@/lib/db';
import { seedOrganization } from '@/lib/seed-data';

export const roles = ['admin', 'manager', 'staff'] as const;
export type Role = (typeof roles)[number];

export async function getActor() {
  const demoRole = await currentDemoRole();
  if (demoRole) return getDemoActor(demoRole);
  const session = await auth();
  if (!session.userId) throw new Error('UNAUTHENTICATED');
  const clerkUser = await currentUser();
  if (!clerkUser) throw new Error('UNAUTHENTICATED');
  const emailAddress = clerkUser.emailAddresses.find((item) => item.id === clerkUser.primaryEmailAddressId && item.verification?.status === 'verified')
    ?? clerkUser.emailAddresses.find((item) => item.verification?.status === 'verified');
  if (!emailAddress) throw new Error('A verified email address is required.');
  const email = emailAddress.emailAddress;
  if ((clerkUser.publicMetadata as { stocksenseDisabled?: unknown }).stocksenseDisabled === true) throw new Error('ACCOUNT_DISABLED');
  let user = await db.user.findUnique({ where: { clerkId: session.userId }, include: { organization: true } });
  if (!user) {
    const invitation = clerkUser.publicMetadata as { stocksenseOrganizationId?: unknown; stocksenseRole?: unknown };
    const invitedOrganizationId = typeof invitation.stocksenseOrganizationId === 'string' ? invitation.stocksenseOrganizationId : null;
    const invitedOrganization = invitedOrganizationId ? await db.organization.findUnique({ where: { id: invitedOrganizationId } }) : null;
    const invitedRole = invitation.stocksenseRole === 'manager' || invitation.stocksenseRole === 'staff' ? invitation.stocksenseRole : 'staff';
    if (invitedOrganizationId && !invitedOrganization) throw new Error('INVITED_WORKSPACE_NOT_FOUND');
    const stem = (clerkUser.username || email.split('@')[0] || 'team').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'team';
    const organization = invitedOrganization || await db.organization.create({ data: { name: `${clerkUser.firstName || stem}'s workspace`, slug: `${stem}-${crypto.randomUUID().slice(0, 8)}` } });
    try {
      user = await db.$transaction(async (tx) => {
        const created = await tx.user.create({ data: { clerkId: session.userId, email: email.toLowerCase(), firstName: clerkUser.firstName, lastName: clerkUser.lastName, avatarUrl: clerkUser.imageUrl, role: invitedOrganization ? invitedRole : 'admin', organizationId: organization.id }, include: { organization: true } });
        if (process.env.SEED_DEMO_DATA === 'true' && process.env.NODE_ENV === 'development') {
          await seedOrganization(tx, organization.id);
        }
        return created;
      });
    } catch (error) {
      if (!invitedOrganization) await db.organization.delete({ where: { id: organization.id } }).catch(() => undefined);
      user = await db.user.findUnique({ where: { clerkId: session.userId }, include: { organization: true } });
      if (!user) throw error;
    }
  } else if (user.status !== 'active' || user.deletedAt) {
    throw new Error('ACCOUNT_DISABLED');
  }
  return user;
}

export async function requireRole(allowed: Role[]) {
  const actor = await getActor();
  if (!allowed.includes(actor.role as Role)) throw new Error('FORBIDDEN');
  return actor;
}
