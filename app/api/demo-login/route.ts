import { NextRequest, NextResponse } from 'next/server';
import { createDemoToken, currentDemoRole, DEMO_COOKIE, DEMO_ROLES, isDemoSessionEnabled, provisionDemoRole } from '@/lib/demo-auth';

export const runtime = 'nodejs';

const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/' };

export async function GET() {
  if (!isDemoSessionEnabled()) return NextResponse.json({ enabled: false, roles: [] });
  const currentRole = await currentDemoRole();
  const roleOptions = DEMO_ROLES.map((role) => ({ role, id: `stocksense_demo_${role}`, email: `${role}@stocksense.local`, name: `Demo ${role[0].toUpperCase()}${role.slice(1)} User` }));
  return NextResponse.json({ enabled: true, currentRole, roles: roleOptions });
}

export async function POST(request: NextRequest) {
  if (!isDemoSessionEnabled()) return NextResponse.json({ error: 'Local demo sign-in is disabled.' }, { status: 404 });
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { role?: unknown };
  const role = DEMO_ROLES.find((candidate) => candidate === body.role);
  if (!role) return NextResponse.json({ error: 'Choose admin, manager, or staff.' }, { status: 422 });

  try {
    await provisionDemoRole(role);
    const response = NextResponse.json({ success: true, role, redirectTo: '/dashboard' });
    response.cookies.set(DEMO_COOKIE, await createDemoToken(role), { ...cookieOptions, maxAge: 60 * 60 * 24 });
    return response;
  } catch (error) {
    console.error('StockSense demo sign-in failed:', error);
    return NextResponse.json({ error: 'Could not prepare the local demo workspace. Check that PostgreSQL is running and the schema is current.' }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isDemoSessionEnabled()) return NextResponse.json({ error: 'Local demo sign-in is disabled.' }, { status: 404 });
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  const response = NextResponse.json({ success: true });
  response.cookies.set(DEMO_COOKIE, '', { ...cookieOptions, maxAge: 0 });
  return response;
}
