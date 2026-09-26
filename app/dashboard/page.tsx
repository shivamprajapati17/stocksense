import { DashboardApp } from '@/components/dashboard-app';
import { currentUser } from '@clerk/nextjs/server';
import { currentDemoRole } from '@/lib/demo-auth';
import { getActor } from '@/lib/auth';

export default async function DashboardPage() {
  const demoRole = await currentDemoRole();
  if (demoRole) await getActor();
  else {
    const user = await currentUser();
    if (user) await getActor();
  }
  return <DashboardApp />;
}
