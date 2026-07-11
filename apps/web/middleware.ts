import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

import { buildCspDirectives } from '@/lib/csp';

// Routes under (app) require authentication.
// /api/clerk/webhook is intentionally excluded — it authenticates via Svix HMAC (Task 9).
const isProtectedRoute = createRouteMatcher([
  '/services(.*)',
  '/domains(.*)',
  '/incidents(.*)',
  '/settings(.*)',
]);

export default clerkMiddleware(
  async (auth, req) => {
    if (isProtectedRoute(req)) await auth.protect();
  },
  {
    // Enforcing CSP. Shipped Report-Only first (PR #21) and validated against
    // prod — header nonce matched Clerk's script nonce, zero violations — then
    // flipped to enforce here. `strict` adds the per-request nonce +
    // strict-dynamic to script-src; Clerk merges its own directives. Requires
    // <ClerkProvider dynamic> (see app/layout.tsx) or Clerk's own script is
    // blocked. Rollback: add `reportOnly: true` back and redeploy.
    contentSecurityPolicy: {
      strict: true,
      directives: buildCspDirectives(
        process.env.NEXT_PUBLIC_API_URL ?? '',
        process.env.NEXT_PUBLIC_WS_URL ?? '',
      ),
    },
  },
);

export const config = {
  matcher: [
    // Run on all paths except Next.js internals and static assets.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ico)).*)',
    '/(api|trpc)(.*)',
  ],
};
