import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// Routes under (app) require authentication.
// /api/clerk/webhook is intentionally excluded — it authenticates via Svix HMAC (Task 9).
const isProtectedRoute = createRouteMatcher([
  '/services(.*)',
  '/domains(.*)',
  '/incidents(.*)',
  '/settings(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect();
});

export const config = {
  matcher: [
    // Run on all paths except Next.js internals and static assets.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ico)).*)',
    '/(api|trpc)(.*)',
  ],
};
