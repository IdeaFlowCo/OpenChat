export interface SecretaryAnswer {
  id: string;
  question: string;
  answer: string;
  createdAt?: string;
  updatedAt?: string;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'again', 'can', 'could', 'do', 'does', 'for', 'from',
  'details', 'give', 'i', 'is', 'it', 'me', 'my', 'of', 'please', 'remind', 'tell', 'that',
  'the', 'their', 'them', 'to', 'us', 'was', 'what', 'when', 'where', 'which',
  'who', 'why', 'would', 'you', 'your',
]);

function normalizedTokens(value: string): string[] {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

/** Conservative deterministic match score, or zero for no match. */
export function secretaryMatchScore(message: string, question: string): number {
  const messageTokens = new Set(normalizedTokens(message));
  const questionTokens = [...new Set(normalizedTokens(question))];
  if (messageTokens.size === 0 || questionTokens.length === 0) return 0;

  const matched = questionTokens.filter((token) => messageTokens.has(token)).length;
  if (questionTokens.length === 1) {
    return questionTokens[0]!.length >= 5 && matched === 1 ? 1 : 0;
  }
  if (questionTokens.length === 2) return matched === 2 ? 1 : 0;
  const coverage = matched / questionTokens.length;
  return matched >= 2 && coverage >= 2 / 3 ? coverage : 0;
}

export function findSecretaryAnswer(
  message: string,
  answers: SecretaryAnswer[]
): SecretaryAnswer | null {
  let best: { answer: SecretaryAnswer; score: number } | null = null;
  for (const answer of answers) {
    const score = secretaryMatchScore(message, answer.question);
    if (score > 0 && (!best || score > best.score)) best = { answer, score };
  }
  return best?.answer ?? null;
}
