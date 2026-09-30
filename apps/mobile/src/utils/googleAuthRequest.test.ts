import { describe, expect, it } from 'vitest';
import { googleAuthRequestConfig, googleIosRedirectUri } from './googleAuthRequest';

const iosClientId = '874749606899-ajd7segoct156poo3gbeoefg3s349626.apps.googleusercontent.com';
const webClientId = 'web-client.apps.googleusercontent.com';
const androidClientId = 'android-client.apps.googleusercontent.com';

describe('native Google sign-in request', () => {
  it('uses a redirect URI handled by the iOS binary and asks Google to show account selection', async () => {
    const { expo } = await import('../../app.config.js');
    const config = googleAuthRequestConfig('ios', iosClientId, androidClientId, webClientId);
    const registeredSchemes = expo.ios.infoPlist.CFBundleURLTypes.flatMap(
      (entry: { CFBundleURLSchemes: string[] }) => entry.CFBundleURLSchemes,
    );

    expect(config.redirectUri).toBe(googleIosRedirectUri(iosClientId));
    expect(registeredSchemes).toContain(config.redirectUri!.split(':')[0]);
    expect(config.redirectUri).not.toBe(`${expo.ios.bundleIdentifier}:/oauthredirect`);
    expect(config.extraParams).toEqual({ prompt: 'select_account' });
  });

  it('leaves Android and web redirect selection to their existing flows', () => {
    expect(googleAuthRequestConfig('android', iosClientId, androidClientId, webClientId).redirectUri).toBeUndefined();
    expect(googleAuthRequestConfig('web', iosClientId, androidClientId, webClientId).redirectUri).toBeUndefined();
  });

  it('rejects a malformed iOS OAuth client ID', () => {
    expect(() => googleIosRedirectUri('not-a-google-client')).toThrow('Invalid Google iOS client ID');
  });
});
