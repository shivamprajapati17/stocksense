import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { isDemoRequestCookie } from '@/lib/demo-session';

const isProtectedRoute = createRouteMatcher(['/dashboard(.*)', '/api/(.*)']);
const isDashboardRoute = createRouteMatcher(['/dashboard(.*)']);
const isHomeRoute = createRouteMatcher(['/']);
const isApiRoute = createRouteMatcher(['/api/(.*)']);
const isDemoLoginApiRoute = createRouteMatcher(['/api/demo-login']);

export default clerkMiddleware(async (auth, request) => {
  const demoEnabled = process.env.NODE_ENV === 'development' && process.env.STOCKSENSE_DEMO_LOGIN === 'true' && Boolean(process.env.STOCKSENSE_DEMO_SECRET || process.env.DATABASE_URL || 'stocksense-local-demo-only');
  if (isDemoLoginApiRoute(request)) return NextResponse.next();
  if (demoEnabled && isHomeRoute(request) && await isDemoRequestCookie(request.cookies.get('stocksense_demo')?.value)) return NextResponse.redirect(new URL('/dashboard', request.url));
  const demoRoute = isDashboardRoute(request) || isApiRoute(request);
  if (demoEnabled && demoRoute) {
    if (await isDemoRequestCookie(request.cookies.get('stocksense_demo')?.value)) return NextResponse.next();
    if (isApiRoute(request)) return NextResponse.json({ error: 'Sign in is required.' }, { status: 401 });
    const signInUrl = new URL('/sign-in', request.url);
    signInUrl.searchParams.set('redirect_url', request.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }
  if (isProtectedRoute(request)) await auth.protect();
});

export const config = {
  matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|pdf)).*)', '/(api|trpc)(.*)', '/__clerk/:path*'],
};
