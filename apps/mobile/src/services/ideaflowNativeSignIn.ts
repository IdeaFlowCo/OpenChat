/**
 * Web (and Node test) stand-in for ideaflowNativeSignIn.native.ts, which Metro
 * resolves on iOS/Android (code-xbh.14). Web signs in with a full-page
 * redirect instead (ideaflowSignIn.ts), so these are never reached there.
 * Keep the exported signatures identical to the native file.
 */

export async function markIdeaflowAccountChoiceNative(): Promise<void> {
  // Web keeps its marker in localStorage (markIdeaflowAccountChoice).
}

export async function takeIdeaflowAccountChoiceNative(): Promise<boolean> {
  return false;
}

export type IdeaflowNativeResult = 'signed-in' | 'cancelled';

export async function authorizeWithIdeaflowNative(_options: { selectAccount?: boolean } = {}): Promise<
  | { kind: 'cancelled' }
  | { kind: 'code'; code: string; codeVerifier: string; nonce: string }
> {
  throw new Error('Native Ideaflow sign-in is only available in the iOS and Android apps.');
}

export async function signInWithIdeaflowNative(): Promise<IdeaflowNativeResult> {
  throw new Error('Native Ideaflow sign-in is only available in the iOS and Android apps.');
}
