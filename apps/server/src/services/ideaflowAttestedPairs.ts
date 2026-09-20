/**
 * Deployer-attested (userId, subject) pairs: accounts whose existing Ideaflow
 * mapping was established by an operator (the pilot / admin pair) rather than by
 * a proof the server can re-derive. Only an EXISTING exact mapping matching both
 * halves of a pair may sign in without the ownership rules that apply to every
 * other mapping (privileged accounts, unproven mappings on password accounts).
 *
 * The pair list comes from server configuration, never from the graph, so no
 * sign-in, Connect or Google flow can add to it. Malformed configuration yields
 * an empty list (fail closed): the account then follows the ordinary rules.
 *
 *   IDEAFLOW_ID_ATTESTED_PAIRS='[{"userId":"<OpenChat user id>","sub":"<Ideaflow subject>"}]'
 */
export interface IdeaflowAttestedPair {
  userId: string;
  sub: string;
}

const MAX_PAIRS = 16;
const MAX_VALUE_LENGTH = 256;

function validValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_VALUE_LENGTH
    && !/[\0\r\n]/.test(value);
}

export function getIdeaflowAttestedPairs(env: NodeJS.ProcessEnv = process.env): IdeaflowAttestedPair[] {
  const raw = env.IDEAFLOW_ID_ATTESTED_PAIRS?.trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_PAIRS) return [];
    const pairs: IdeaflowAttestedPair[] = [];
    for (const entry of parsed) {
      const candidate = entry as { userId?: unknown; sub?: unknown } | null;
      if (!candidate || !validValue(candidate.userId) || !validValue(candidate.sub)) return [];
      pairs.push({ userId: candidate.userId, sub: candidate.sub });
    }
    return pairs;
  } catch {
    return [];
  }
}

export function isIdeaflowAttestedPair(
  userId: string,
  sub: string,
  pairs: IdeaflowAttestedPair[] = getIdeaflowAttestedPairs(),
): boolean {
  return pairs.some(pair => pair.userId === userId && pair.sub === sub);
}
