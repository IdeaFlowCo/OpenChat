/**
 * Which look the app wears: the current Ink & Paper, or the Slate
 * alternative being compared against it (see palette.ts).
 *
 * Slate is the default. On web, open the app once with `?look=slate` (or
 * `?look=paper` to go back) and the choice is remembered in this browser.
 * It is read once at start-up, so a change takes effect on reload. The Appearance setting persists the look on every platform.
 */
import type { Look } from './palette';

const KEY = 'openchat_look';
const isLook = (value: unknown): value is Look => value === 'paper' || value === 'slate';

/** Pure: what to wear given the URL query and what was remembered. */
export function resolveLook(search: string | undefined, stored: string | null | undefined): { look: Look; remember: boolean } {
  const asked = /[?&]look=([a-z]+)/i.exec(search ?? '')?.[1]?.toLowerCase();
  if (isLook(asked)) return { look: asked, remember: true };
  return { look: isLook(stored) ? stored : 'slate', remember: false };
}

function initial(): Look {
  try {
    const web = globalThis as { location?: { search?: string }; localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } };
    if (!web.location || !web.localStorage) return 'slate';
    const resolved = resolveLook(web.location.search, web.localStorage.getItem(KEY));
    if (resolved.remember) web.localStorage.setItem(KEY, resolved.look);
    return resolved.look;
  } catch {
    return 'slate';
  }
}

let look = initial();
export const setLook = (next: Look): void => { look = next; };
export const getLook = (): Look => look;
