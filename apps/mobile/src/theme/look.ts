/**
 * Which look the app wears: the current Ink & Paper, or the Slate
 * alternative being compared against it (see palette.ts).
 *
 * Web only, and opt-in: open the app once with `?look=slate` (or
 * `?look=paper` to go back) and the choice is remembered in this browser.
 * It is read once at start-up, so a change takes effect on reload. Native
 * builds and everyone who never passes the parameter stay on Ink & Paper.
 */
import type { Look } from './palette';

const KEY = 'openchat_look';
const isLook = (value: unknown): value is Look => value === 'paper' || value === 'slate';

/** Pure: what to wear given the URL query and what was remembered. */
export function resolveLook(search: string | undefined, stored: string | null | undefined): { look: Look; remember: boolean } {
  const asked = /[?&]look=([a-z]+)/i.exec(search ?? '')?.[1]?.toLowerCase();
  if (isLook(asked)) return { look: asked, remember: true };
  return { look: isLook(stored) ? stored : 'paper', remember: false };
}

function initial(): Look {
  try {
    const web = globalThis as { location?: { search?: string }; localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } };
    if (!web.location || !web.localStorage) return 'paper';
    const resolved = resolveLook(web.location.search, web.localStorage.getItem(KEY));
    if (resolved.remember) web.localStorage.setItem(KEY, resolved.look);
    return resolved.look;
  } catch {
    return 'paper';
  }
}

const look = initial();
export const getLook = (): Look => look;
