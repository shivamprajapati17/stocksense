import { auth } from '@clerk/nextjs/server';
import { currentDemoRole } from '@/lib/demo-auth';
import { redirect } from 'next/navigation';

export default async function HomePage() {
  if (await currentDemoRole()) redirect('/dashboard');
  const { userId } = await auth();
  redirect(userId ? '/dashboard' : '/sign-in');
}
