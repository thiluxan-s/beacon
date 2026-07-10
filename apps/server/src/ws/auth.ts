import { verifyToken } from '@clerk/backend';
import { env } from '../lib/env';
import { getByClerkId } from '../db/repositories/users';
import { publicModeEnabled, publicOwnerClerkId } from '../lib/public-mode';

type VerifyFn = (token: string) => Promise<{ sub: string }>;
type ResolveFn = (clerkId: string) => Promise<{ userId: string } | null>;

// Note: verifyToken re-exported from @clerk/backend index returns Promise<JwtPayload>
// (throws TokenVerificationError on failure); the outer try/catch converts throws to null.
const defaultVerify: VerifyFn = async (token) => {
  const claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
  return { sub: String(claims.sub) };
};
const defaultResolveByClerk: ResolveFn = async (clerkId) => {
  const user = await getByClerkId(clerkId);
  return user ? { userId: user.id } : null;
};

export async function authenticateConnection(
  token: string | undefined,
  opts: { public?: boolean } = {},
  deps: { verify?: VerifyFn; resolveByClerk?: ResolveFn; resolveOwner?: () => Promise<{ userId: string } | null> } = {},
): Promise<{ userId: string; public: boolean } | null> {
  const resolveByClerk = deps.resolveByClerk ?? defaultResolveByClerk;

  if (opts.public) {
    if (!publicModeEnabled()) return null;
    const resolveOwner = deps.resolveOwner ?? (() => resolveByClerk(publicOwnerClerkId()!));
    const owner = await resolveOwner();
    return owner ? { userId: owner.userId, public: true } : null;
  }

  if (!token) return null;
  const verify = deps.verify ?? defaultVerify;
  try {
    const { sub } = await verify(token);
    const resolved = await resolveByClerk(sub);
    return resolved ? { userId: resolved.userId, public: false } : null;
  } catch {
    return null;
  }
}
