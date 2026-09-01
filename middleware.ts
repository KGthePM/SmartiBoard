import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { authorizeDesktopRequest } from '@/lib/desktop-security';

/**
 * Electron injects this transient header in its private session. The token is
 * never exposed through preload or page JavaScript. When the variables are
 * absent, this is the same open local/self-hosted app it has always been.
 */
export function middleware(request: NextRequest) {
  const requiredToken = process.env['SMARTI_DESKTOP_TOKEN'];
  const requiredHost = process.env['SMARTI_DESKTOP_HOST'];
  const suppliedHost = request.headers.get('host');
  if (
    requiredToken?.trim() &&
    suppliedHost === requiredHost &&
    request.nextUrl.pathname === '/__smarti_desktop_ready'
  ) {
    return new NextResponse(null, {
      status: 204,
      headers: { 'x-smarti-desktop-instance': process.env['SMARTI_DESKTOP_INSTANCE'] ?? '' },
    });
  }
  const allowed = authorizeDesktopRequest({
    // Dynamic lookup is deliberate: these values are generated after build.
    requiredToken,
    requiredHost,
    suppliedToken: request.headers.get('x-smarti-desktop-token'),
    suppliedHost,
  });
  return allowed ? NextResponse.next() : new NextResponse('Not found', { status: 404 });
}

export const config = {
  matcher: '/:path*',
  runtime: 'nodejs',
};
