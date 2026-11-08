export type WebRoute = 'monitor' | 'analytics' | 'access' | 'recovery' | 'legacy';

export function resolveRoute(pathname: string): WebRoute {
  if (pathname === '/analytics.html' || pathname === '/index.html') return 'analytics';
  if (pathname === '/access.html') return 'access';
  if (pathname === '/recovery-console.html') return 'recovery';
  if (pathname === '/legacy.html') return 'legacy';
  return 'monitor';
}
