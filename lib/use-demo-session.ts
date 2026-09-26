'use client';

import { useEffect, useState } from 'react';
import type { DemoRole } from '@/lib/demo-types';

export function useDemoSession() {
  const [role, setRole] = useState<DemoRole | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/demo-login').then((response) => response.json()).then((result) => {
      if (active && result.enabled && ['admin', 'manager', 'staff'].includes(result.currentRole)) setRole(result.currentRole as DemoRole);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  if (!role) return null;
  return {
    role,
    async signOut() {
      await fetch('/api/demo-login', { method: 'DELETE' });
      window.location.assign('/sign-in');
    },
    async switchRole() {
      const next = role === 'admin' ? 'manager' : role === 'manager' ? 'staff' : 'admin';
      const response = await fetch('/api/demo-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: next }) });
      if (!response.ok) throw new Error('Unable to switch demo role.');
      window.location.reload();
    },
  };
}
