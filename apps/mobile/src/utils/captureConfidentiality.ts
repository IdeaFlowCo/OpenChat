export const LOCAL_ONLY_CAPTURE_MESSAGE = 'This draft contains confidential information. It has not been sent. Store it locally in an appropriate secure app; this draft is not saved locally.';

export function isLocalOnlyCapture(text: string, label = '', tags: string[] = []): boolean {
  const normalized = text.normalize('NFKC').toLowerCase();
  const field = label.normalize('NFKC').toLowerCase();
  const identifiers = /\b(?:ssn|social security|passport|driver.?s? licen[cs]e|tax[ -]?(?:id|identifier|identification)|national[ -]?id|government[ -]?id|account|routing|(?:credit |debit |payment )?card number|credit card|debit card|confidential)\b/;
  if (identifiers.test(field)) return true;
  if (tags.some(tag => tag.normalize('NFKC').toLowerCase().replace(/^#/, '') === 'confidential')) return true;
  if (/(?:^|[^\p{L}\p{N}_])#confidential(?![\p{L}\p{M}\p{N}_-])/u.test(normalized)) return true;
  if (/\b(?:ssn|social security|passport|driver.?s? licen[cs]e|tax[ -]?(?:id|identifier|identification)|national[ -]?id|government[ -]?id|(?:bank |financial )?account(?: number)?|routing(?: number)?|(?:credit |debit |payment )?card number|credit card|debit card|confidential)(?:\s*[:#=-]\s*\S|\s+[a-z0-9])/.test(normalized)) return true;
  if (/(?:^|\D)\d{3}-\d{2}-\d{4}(?!\d)/.test(normalized)) return true;
  for (const match of normalized.matchAll(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g)) {
    const digits = Array.from(match[0].replace(/\D/g, ''), Number);
    if (digits.length < 13 || new Set(digits).size < 2) continue;
    const sum = digits.reverse().reduce((total, digit, index) => {
      const value = index % 2 ? digit * 2 : digit;
      return total + (value > 9 ? value - 9 : value);
    }, 0);
    if (sum % 10 === 0) return true;
  }
  return false;
}
