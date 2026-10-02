// The Ideaflow provider session outlives an OpenChat sign-out. After someone
// explicitly signs out, the next "Sign in with Ideaflow" sends prompt=login so
// the provider asks who is signing in instead of reusing that session.
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
  try { storage()?.setItem(KEY, '1'); } catch { /* storage blocked: provider chooser still offers a switch */ }
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
