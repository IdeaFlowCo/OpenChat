/**
 * Cohort gate for the Ideaflow ID rollout.
 *
 * This sits alongside — never instead of — IDEAFLOW_ID_ENABLED
 * (see ideaflowOidc.ts). The kill switch turns the whole integration off;
 * the cohort gate scopes who can actually exchange a code, link an identity,
 * or have a brand-new OpenChat user created while the integration is on.
 *
 * Fails closed: an unset or empty allowlist admits nobody, even though the
 * kill switch is on and credentials are configured. An operator must
 * explicitly opt a cohort in.
 */
export interface IdeaflowCohortConfig {
  /** True when IDEAFLOW_ID_COHORT_ALLOWLIST is exactly "*" — full rollout. */
  allowAllVerifiedEmails: boolean;
  /** Lowercased, trimmed emails explicitly admitted to the cohort. */
  allowlist: Set<string>;
  /**
   * Whether an Ideaflow ID sign-in with no existing durable mapping and no
   * local email match is allowed to create a brand-new OpenChat user.
   * Defaults to false: unmapped identities are refused during the cohort
   * rollout rather than silently minting new accounts.
   */
  allowNewUserCreation: boolean;
}

export function getIdeaflowCohortConfig(
  env: NodeJS.ProcessEnv = process.env,
): IdeaflowCohortConfig {
  const raw = (env.IDEAFLOW_ID_COHORT_ALLOWLIST || '').trim();
  const allowAllVerifiedEmails = raw === '*';
  const allowlist = new Set(
    allowAllVerifiedEmails
      ? []
      : raw
        .split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean),
  );

  return {
    allowAllVerifiedEmails,
    allowlist,
    allowNewUserCreation: env.IDEAFLOW_ID_ALLOW_NEW_USER_CREATION === 'true',
  };
}

/**
 * `email` must already be verified (email_verified: true on the ID token) —
 * this function does not itself check verification. Email is only ever used
 * here as a temporary rollout selector, never as durable identity.
 */
export function isCohortEmailAllowed(
  email: string,
  cohort: IdeaflowCohortConfig,
): boolean {
  if (cohort.allowAllVerifiedEmails) return true;
  return cohort.allowlist.has(email.trim().toLowerCase());
}
