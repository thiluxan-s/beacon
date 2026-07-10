// Read live from process.env (not the frozen `env`) so tests can toggle with
// vi.stubEnv and an unset value cleanly disables the feature — same pattern as
// the Resend email vars in lib/email.ts.
export function publicOwnerClerkId(): string | undefined {
  return process.env.PUBLIC_OWNER_CLERK_ID || undefined;
}

export function publicModeEnabled(): boolean {
  return Boolean(publicOwnerClerkId());
}
