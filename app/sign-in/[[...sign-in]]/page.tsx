'use client';
import { SignIn } from '@clerk/nextjs';
import { useEffect, useState } from 'react';

const demoRoles = [
  { role: 'admin', name: 'Admin', description: 'Full workspace access' },
  { role: 'manager', name: 'Manager', description: 'Inventory and approvals' },
  { role: 'staff', name: 'Staff', description: 'Day-to-day inventory' },
] as const;

export default function SignInPage() {
  const [demoEnabled, setDemoEnabled] = useState<boolean | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState('');

  useEffect(() => {
    fetch('/api/demo-login').then((response) => response.json()).then((result) => setDemoEnabled(result.enabled === true)).catch(() => setDemoEnabled(false));
  }, []);

  const signInDemo = async (role: typeof demoRoles[number]['role']) => {
    setDemoBusy(true);
    setDemoError('');
    try {
      const response = await fetch('/api/demo-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not sign in to the demo.');
      window.location.assign('/dashboard');
    } catch (error) {
      setDemoError(error instanceof Error ? error.message : 'Could not sign in to the demo.');
      setDemoBusy(false);
    }
  };

  return <main className="auth-shell"><div className="auth-brand"><span className="brand-mark">S</span><span>StockSense</span></div><p className="auth-kicker">INVENTORY, IN VIEW</p><SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />{demoEnabled && <section className="demo-login" aria-label="Local demo role sign-in"><div className="demo-divider"><span>or explore a demo role</span></div><div className="demo-role-list">{demoRoles.map((item) => <button key={item.role} className="demo-role-button" disabled={demoBusy} onClick={() => signInDemo(item.role)}><span><strong>{item.name}</strong><small>{item.description}</small></span><span className="demo-role-arrow">→</span></button>)}</div>{demoError && <p className="demo-error" role="alert">{demoError}</p>}</section>}</main>;
}
