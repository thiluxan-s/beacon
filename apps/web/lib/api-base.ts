// Base URL for server-side calls to the Hono API.
// In production, INTERNAL_API_URL=http://server:3001 keeps web->server traffic on
// the Docker network (never out through Caddy). Locally it is unset, so we fall back
// to NEXT_PUBLIC_API_URL (http://localhost:3001). Empty string is intentional last
// resort so a misconfig surfaces as a fetch error, not a thrown ReferenceError.
export function serverApiBaseUrl(): string {
  const internal = process.env.INTERNAL_API_URL;
  if (internal && internal.length > 0) return internal;
  return process.env.NEXT_PUBLIC_API_URL ?? '';
}
