import type { GoogleAuthRequestConfig } from 'expo-auth-session/providers/google';

const GOOGLE_CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';

export function googleIosRedirectUri(clientId: string): string {
  if (!clientId.endsWith(GOOGLE_CLIENT_ID_SUFFIX)) {
    throw new Error('Invalid Google iOS client ID');
  }
  const id = clientId.slice(0, -GOOGLE_CLIENT_ID_SUFFIX.length);
  return `com.googleusercontent.apps.${id}:/oauthredirect`;
}

export function googleAuthRequestConfig(
  platform: string,
  iosClientId: string,
  androidClientId: string,
  webClientId: string,
): Partial<GoogleAuthRequestConfig> {
  return {
    iosClientId,
    androidClientId,
    webClientId,
    clientId: iosClientId,
    // SDK 54 defaults to Application.applicationId:/oauthredirect, which is
    // not the reverse-client-ID URL scheme registered in this iOS app.
    redirectUri: platform === 'ios' ? googleIosRedirectUri(iosClientId) : undefined,
    scopes: ['openid', 'email', 'profile'],
    shouldAutoExchangeCode: true,
    extraParams: { prompt: 'select_account' },
  };
}
