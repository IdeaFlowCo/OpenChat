import { OPENCHAT_URL, getToken, ApiError } from '../api/client';

export type TransformType = 'nvc' | 'concise' | 'formal' | 'casual' | 'translate';

export interface TransformOptions {
  targetLanguage?: string;
}

/**
 * Call POST /api/ai/transform and return the rewritten text.
 * Throws ApiError on rate-limit (429) or other server errors.
 */
export async function transformMessage(
  text: string,
  transform: TransformType,
  opts?: TransformOptions,
): Promise<string> {
  const token = await getToken();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (token) headers['authorization'] = `Bearer ${token}`;

  const body: Record<string, string> = { text, transform };
  if (transform === 'translate' && opts?.targetLanguage) {
    body['targetLanguage'] = opts.targetLanguage;
  }

  const res = await fetch(`${OPENCHAT_URL}/api/ai/transform`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const responseText = await res.text();
  if (!res.ok) {
    let msg = responseText;
    try {
      const j = JSON.parse(responseText);
      msg = j.error || j.message || responseText;
    } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status}: ${msg}`, responseText);
  }

  const data = JSON.parse(responseText) as { rewritten: string };
  return data.rewritten;
}

export const TRANSFORM_LABELS: Record<TransformType, string> = {
  nvc: 'NVC Rewrite',
  concise: 'Make Concise',
  formal: 'More Formal',
  casual: 'More Casual',
  translate: 'Translate...',
};

export const TRANSLATE_LANGUAGES = [
  'Spanish',
  'French',
  'German',
  'Japanese',
  'Mandarin',
  'Hindi',
  'Arabic',
  'Portuguese',
];
