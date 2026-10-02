// The Ideaflow provider session outlives an OpenChat sign-out, and without a
// prompt the provider signs that same account straight back in. After someone
// explicitly signs out, the next "Sign in with Ideaflow" sends
// prompt=select_account so the provider asks which account to use.
// Web only: native shells don't use the Ideaflow redirect flow.

const KEY = 'openchat_ideaflow_choose_account';

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function markIdeaflowAccountChoice(): void {
  try { storage()?.setItem(KEY, '1'); } catch { /* storage blocked: next sign-in reuses the provider session */ }
}

/** Returns true once after an explicit sign-out, then clears the marker. */
export function takeIdeaflowAccountChoice(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const marked = store.getItem(KEY) === '1';
    store.removeItem(KEY);
    return marked;
  } catch {
    return false;
  }
}
