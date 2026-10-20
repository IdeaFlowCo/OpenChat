type Guard = (token: string | null) => Promise<boolean>;
let guard: Guard | null = null;

export function setAuthenticatedRequestGuard(next: Guard): () => void {
  guard = next;
  return () => { if (guard === next) guard = null; };
}

export async function authenticatedRequestLease(token: string | null): Promise<() => Promise<void>> {
  const owner = guard;
  const check = async () => {
    if (!owner || !await owner(token) || owner !== guard) {
      throw new Error('Account identity is not verified');
    }
  };
  await check();
  return check;
}
