import { isSafeCardLink, type StrangerCard } from './addMeCard.js';
import { DEFAULT_PUBLIC_DISPLAY_NAME } from '../privacy/profilePrivacy.js';

/** RFC 2426 text escaping. Normalize all line endings before escaping so an
 * owner-controlled field cannot introduce another vCard property. */
function textValue(value: string): string {
  return [...value.replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, '\n')]
    .filter(char => {
      const code = char.charCodeAt(0);
      return code === 10 || (code >= 32 && (code < 127 || code > 159));
    })
    .join('')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function foldLine(line: string): string {
  let result = '';
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > 75) {
      result += '\r\n ';
      bytes = 1;
    }
    result += char;
    bytes += size;
  }
  return result;
}

/** Receives only the authorized stranger projection, never an owner record. */
export function renderCardVcard(card: StrangerCard, token: string): string {
  const name = textValue(card.name) || DEFAULT_PUBLIC_DISPLAY_NAME;
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:;${name};;;`,
    `FN:${name}`,
  ];

  if (card.headline) lines.push(`NOTE:${textValue(card.headline)}`);
  for (const value of [card.linkedIn, card.x, card.link]) {
    if (value && isSafeCardLink(value)) lines.push(`URL:${new URL(value).href}`);
  }
  // The token is validated by resolveCardToken before this function is called.
  lines.push(`URL:https://chat.globalbr.ai/c/${token}`, 'END:VCARD');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
