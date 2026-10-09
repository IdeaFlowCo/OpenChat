import privacyPolicy from '../../../../scripts/message-companion/capture-privacy.json' with { type: 'json' };

export const LOCAL_ONLY_CAPTURE_MESSAGE = 'This draft contains confidential information. It has not been sent. Store it locally in an appropriate secure app; this draft is not saved locally.';

const labelSeparators = new RegExp(privacyPolicy.labelSeparators, 'g');
const explicitLabel = new RegExp(privacyPolicy.explicitLabelPattern);
const normalize = (text: string) => text.normalize(privacyPolicy.normalization).toLowerCase();
const hasConfidentialLabel = (text: string) => explicitLabel.test(normalize(text).replace(labelSeparators, ' '));

export function isLocalOnlyCapture(text: string, label = '', tags: string[] = []): boolean {
  const normalized = normalize(text);
  if (hasConfidentialLabel(text) || hasConfidentialLabel(label)) return true;
  if (tags.some(tag => normalize(tag).replace(/^#/, '') === 'confidential')) return true;
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
