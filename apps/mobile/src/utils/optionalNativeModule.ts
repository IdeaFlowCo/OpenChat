import { requireOptionalNativeModule } from 'expo';

/**
 * Is this app binary built with the named Expo native module?
 *
 * Check this BEFORE import()ing an optional native package. In a release build
 * Metro reports an error thrown while a module loads as fatal, so a missing
 * native module closes the app before the import's rejection handler can run
 * (build 135 crash, 2026-10-23). A try/catch around the import is not enough.
 */
export function hasNativeModule(name: string): boolean {
  try {
    return requireOptionalNativeModule(name) != null;
  } catch {
    return false;
  }
}
