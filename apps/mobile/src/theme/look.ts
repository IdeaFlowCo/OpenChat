/**
 * Which palette the app wears: Slate (the default) or Ink & Paper.
 *
 * Settings › Appearance stores the choice on every platform. On web,
 * `?look=slate` or `?look=paper` also sets and remembers it for this browser.
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
