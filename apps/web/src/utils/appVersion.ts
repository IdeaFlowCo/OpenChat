export const APP_VERSION = __APP_VERSION__;
export const APP_BUILD_DATE = __APP_BUILD_DATE__;
export const APP_GIT_SHA = __APP_GIT_SHA__;
export const APP_GIT_BRANCH = __APP_GIT_BRANCH__;
export const IS_DEV_BUILD = import.meta.env.MODE !== 'production';
export const TOP_BAR_VERSION_KEY = 'openchat_show_version_top_bar';

export function formatVersion(includeDevMeta = IS_DEV_BUILD): string {
  const base = `v${APP_VERSION}`;
  if (!includeDevMeta || !IS_DEV_BUILD) return base;
  const branch = APP_GIT_BRANCH || 'unknown';
  const sha = APP_GIT_SHA || 'unknown';
  return `${base} (dev ${branch} ${sha})`;
}

export function defaultShowVersionInTopBar(): boolean {
  return IS_DEV_BUILD;
}

export function readShowVersionInTopBar(): boolean {
  const stored = localStorage.getItem(TOP_BAR_VERSION_KEY);
  if (stored === null) return defaultShowVersionInTopBar();
  return stored === 'true';
}

export function writeShowVersionInTopBar(value: boolean): void {
  localStorage.setItem(TOP_BAR_VERSION_KEY, String(value));
}
