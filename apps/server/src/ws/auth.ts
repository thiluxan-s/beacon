import { verifyToken } from '@clerk/backend';
import { env } from '../lib/env';
import { getByClerkId } from '../db/repositories/users';

type VerifyFn = (token: string) => Promise<{ sub: string }>;

// Note: verifyToken re-exported from @clerk/backend index returns Promise<JwtPayload>
// (throws TokenVerificationError on failure); the outer try/catch converts throws to null.
const defaultVerify: VerifyFn = async (token) => {
  const claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
  return { sub: String(claims.sub) };
};

export async function authenticateConnection(
  token: string | undefined,
  deps: { verify?: VerifyFn } = {},
): Promise<{ userId: string } | null> {
  if (!token) return null;
  const verify = deps.verify ?? defaultVerify;
  try {
    const { sub } = await verify(token);
    const user = await getByClerkId(sub);
    return user ? { userId: user.id } : null;
  } catch {
    return null;
  }
}
