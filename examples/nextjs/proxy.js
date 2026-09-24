// The landing page and reference are static files from public/, so the proxy
// is the only server code that runs for them. It evaluates the cloud flag
// (toolbar overrides included) and answers with a plain cookie the pages' boot
// script reads before first paint to reveal what the flag hides. The matcher
// names only document routes: static assets skip the proxy entirely.
import { NextResponse } from 'next/server';
import { cloud } from './flags.js';

export async function proxy(request) {
  const on = await cloud.run({ identify: undefined, request });
  const response = NextResponse.next();
  if (on) response.cookies.set('jev-cloud', '1', { path: '/', sameSite: 'lax' });
  else if (request.cookies.has('jev-cloud')) response.cookies.delete('jev-cloud');
  return response;
}

export const config = {
  matcher: ['/', '/reference', '/examples/:path*'],
};
