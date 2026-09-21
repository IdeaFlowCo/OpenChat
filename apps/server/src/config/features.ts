const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Friends-only beta default: let signed-in users browse accounts which retain
 * the default name-discoverable privacy setting. Set the environment variable
 * to 0/false/no/off to restore query-required discovery immediately.
 */
export function isOpenUserDirectoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.OPENCHAT_OPEN_USER_DIRECTORY?.trim().toLowerCase();
  return configured === undefined || !FALSE_VALUES.has(configured);
}

/**
 * Feature flag for the Context Lane v1 implementation.
 * Defaults to false as requested by the plan.
 */
export function isContextLaneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.OPENCHAT_CONTEXT_LANE?.trim().toLowerCase();
  return configured !== undefined && !FALSE_VALUES.has(configured);
}
