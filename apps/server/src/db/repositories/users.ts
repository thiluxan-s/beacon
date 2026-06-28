import { eq } from 'drizzle-orm';
import { db } from '../index';
import { users, type User } from '../schema';

export async function getByClerkId(clerkUserId: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId)).limit(1);
  return rows[0] ?? null;
}

export async function upsertFromClerk(input: {
  clerkUserId: string;
  email: string;
}): Promise<User> {
  const rows = await db
    .insert(users)
    .values({ clerkUserId: input.clerkUserId, email: input.email })
    .onConflictDoUpdate({
      target: users.clerkUserId,
      set: { email: input.email, updatedAt: new Date() },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsertFromClerk: no row returned');
  return row;
}
