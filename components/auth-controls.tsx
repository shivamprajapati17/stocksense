'use client';

import { SignOutButton, UserButton } from '@clerk/nextjs';
import { useDemoSession } from '@/lib/use-demo-session';

export function AuthControls() {
  const demoSession = useDemoSession();
  if (demoSession) return <div className="demo-session-card"><span>LOCAL DEMO ROLE</span><strong>{demoSession.role[0].toUpperCase() + demoSession.role.slice(1)}</strong><button onClick={() => { void demoSession.switchRole(); }}>Switch role</button><button onClick={() => { void demoSession.signOut(); }}>Exit demo</button></div>;
  return <><UserButton afterSignOutUrl="/sign-in" /><SignOutButton><button className="signout-icon" aria-label="Sign out" title="Sign out">↗</button></SignOutButton></>;
}
