/**
 * Copy and selection helpers shared by every surface that shows authored text
 * (OpenChat copy/select audit, 2026-11). See docs/audits/2026-11-copy-select-edit-audit.md.
 */
import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';

/** Copies `text` to the clipboard. Resolves false on empty text or any failure; never throws. */
export async function copyText(text: string | null | undefined): Promise<boolean> {
  if (!text) return false;
  try { return (await Clipboard.setStringAsync(text)) !== false; }
  catch { return false; }
}

/**
 * True when the browser has a non-empty text selection. Press handlers on web
 * use it so that finishing a drag-selection inside a tappable card selects the
 * text instead of opening, editing or collapsing the card. Always false on native.
 */
export function hasActiveTextSelection(): boolean {
  if (Platform.OS !== 'web') return false;
  const selection = (globalThis as { getSelection?: () => { isCollapsed?: boolean; toString(): string } | null }).getSelection?.();
  return !!selection && selection.isCollapsed !== true && selection.toString().trim().length > 0;
}

/** The text a chat message offers to Copy: its content, else a voice transcript. */
export function messageCopyText(message: { content?: string | null; transcript?: string | null; deletedAt?: string | null }): string {
  if (message.deletedAt) return '';
  if (message.content?.trim()) return message.content;
  return message.transcript?.trim() ? message.transcript : '';
}
