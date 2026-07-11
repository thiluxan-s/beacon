// Builds Beacon's own CSP directives. Clerk's clerkMiddleware merges its
// required directives on top of these (the script-src nonce + strict-dynamic,
// its Frontend API in connect-src, img.clerk.com, Turnstile frame-src, OAuth
// form-action), so we supply only what the app itself needs. connect-src is
// derived from the two public URLs so dev/localhost/prod all work without
// hardcoded hosts. This is passed as `directives` to the CSP option; it is
// never emitted as an enforcing header on its own (Report-Only this PR).

type CspDirectives = {
  'default-src': string[];
  'connect-src': string[];
  'style-src': string[];
  'img-src': string[];
  'font-src': string[];
  'object-src': string[];
  'base-uri': string[];
  'frame-ancestors': string[];
  'form-action': string[];
};

// Parse a URL to its origin (scheme://host[:port]). ws/wss are special
// schemes, so URL.origin returns a usable value for the WS URL too. Returns
// null (rather than throwing) for an empty or malformed value so a
// misconfigured env degrades connect-src instead of crashing middleware.
function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildCspDirectives(apiUrl: string, wsUrl: string): CspDirectives {
  const origins = [safeOrigin(apiUrl), safeOrigin(wsUrl)].filter(
    (o): o is string => o !== null,
  );
  const connectSrc = Array.from(new Set(["'self'", ...origins]));

  return {
    'default-src': ["'self'"],
    'connect-src': connectSrc,
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
  };
}
