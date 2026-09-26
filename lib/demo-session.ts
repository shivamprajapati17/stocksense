import { DEMO_ROLES, type DemoRole } from '@/lib/demo-types';

export const DEMO_COOKIE = 'stocksense_demo';
export { DEMO_ROLES, type DemoRole };

const signingSecret = () => process.env.STOCKSENSE_DEMO_SECRET || process.env.DATABASE_URL || 'stocksense-local-demo-only';
const enabled = () => process.env.NODE_ENV === 'development' && process.env.STOCKSENSE_DEMO_LOGIN !== 'false' && Boolean(signingSecret());
const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0));

async function key() {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(signingSecret()!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function isDemoSessionEnabled() {
  return enabled();
}

export async function isDemoRequestCookie(token?: string | null) {
  return (await verifyDemoToken(token)) !== null;
}

export async function createDemoToken(role: DemoRole) {
  const payload = encode(new TextEncoder().encode(JSON.stringify({ role, expiresAt: Date.now() + 24 * 60 * 60 * 1000 })));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(), new TextEncoder().encode(payload)));
  return `${payload}.${encode(signature)}`;
}

export async function verifyDemoToken(token?: string | null): Promise<DemoRole | null> {
  if (!enabled() || !token) return null;
  try {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const valid = await crypto.subtle.verify('HMAC', await key(), decode(signature), new TextEncoder().encode(payload));
    if (!valid) return null;
    const session = JSON.parse(new TextDecoder().decode(decode(payload))) as { role?: unknown; expiresAt?: unknown };
    if (typeof session.expiresAt !== 'number' || session.expiresAt <= Date.now()) return null;
    return DEMO_ROLES.find((role) => role === session.role) ?? null;
  } catch {
    return null;
  }
}
