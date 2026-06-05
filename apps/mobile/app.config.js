/**
 * app.config.js (OpenChat-601) — env-driven Expo config.
 *
 * Replaces the previous static app.json so the web-target baseUrl can be
 * switched between /m (mobile-web build at /m/*) and /d (desktop-responsive
 * build at /d/*) from a single openchat-mobile checkout. Both /m/ and /d/
 * deploys come from the same `main` branch — no more desktop-responsive
 * branch to sync.
 *
 *   IS_WEB_BUILD=1 OPENCHAT_BASE_URL=/m npx expo export --platform web \
 *     --output-dir dist-web-m --clear
 *
 *   IS_WEB_BUILD=1 OPENCHAT_BASE_URL=/d npx expo export --platform web \
 *     --output-dir dist-web-d --clear
 *
 * CRITICAL — DO NOT set OPENCHAT_BASE_URL during native (EAS) builds.
 * Setting `experiments.baseUrl` on iOS / Android corrupts deep links and
 * asset mapping. The IS_WEB_BUILD gate below ensures `baseUrl` is only
 * applied to web exports. EAS Build does NOT set IS_WEB_BUILD.
 *
 * Per Gemini + Codex independent reviews 2026-06-01.
 */

const isWebBuild = process.env.IS_WEB_BUILD === '1' || process.env.IS_WEB_BUILD === 'true';
const baseUrl = isWebBuild ? process.env.OPENCHAT_BASE_URL : undefined;

module.exports = {
  expo: {
    name: 'OpenChat',
    slug: 'openchat-mobile',
    version: '0.1.21',
    orientation: 'portrait',
    icon: './assets/icon.png',
    scheme: 'openchat',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,

    // EAS Update (OTA) — ship JS/asset-only changes without a TestFlight build
    // (oc8.2 / openchat-3jq.1). runtimeVersion=appVersion: an OTA update only
    // reaches installs whose native app version matches, so we never push JS
    // that's incompatible with the installed native runtime. checkAutomatically
    // ON_LOAD: the app pulls a fresh bundle on launch. Native changes still
    // require a new build (which bumps version -> new runtimeVersion).
    updates: {
      url: 'https://u.expo.dev/fc828863-4fa4-4b62-97f6-8c00ce1dffe3',
      enabled: true,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    },
    runtimeVersion: { policy: 'appVersion' },

    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.jacobcole.openchat',
      buildNumber: '1',
      // NOTE — associatedDomains intentionally commented out for now.
      // Adding it requires enabling the 'Associated Domains' capability on
      // the App ID via the Apple Developer Portal (or ASC API). Without
      // that, EAS Build fails generating the provisioning profile (saw on
      // build 40, 2026-06-01). Universal Links are tracked in OpenChat-84u.2
      // for proper provisioning + re-enable. The openchat:// URL scheme +
      // AASA file + web window.location parsing already cover the deep-
      // link UX without Apple-side capability work.
      //
      // associatedDomains: ['applinks:chat.globalbr.ai'],
      entitlements: {
        'com.apple.developer.applesignin': ['Default'],
      },
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        UIBackgroundModes: ['remote-notification'],
        NSCameraUsageDescription:
          'OpenChat uses the camera to scan QR codes for adding contacts and joining group chats.',
        NSPhotoLibraryUsageDescription:
          'OpenChat uses your photo library so you can share images in chats.',
        NSMicrophoneUsageDescription:
          'OpenChat uses the microphone to record voice messages.',
        CFBundleURLTypes: [
          {
            CFBundleURLSchemes: [
              'com.googleusercontent.apps.874749606899-ajd7segoct156poo3gbeoefg3s349626',
            ],
          },
        ],
      },
    },

    android: {
      package: 'com.jacobcole.openchat',
      adaptiveIcon: {
        backgroundColor: '#3b82f6',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      predictiveBackGestureEnabled: false,
    },

    web: {
      favicon: './assets/favicon.png',
    },

    extra: {
      eas: {
        projectId: 'fc828863-4fa4-4b62-97f6-8c00ce1dffe3',
      },
    },

    // baseUrl ONLY set during web exports (when IS_WEB_BUILD=1). Native
    // builds (EAS) leave this undefined to keep deep links + asset mapping
    // intact. See header comment.
    experiments: baseUrl ? { baseUrl } : {},

    plugins: [
      'expo-secure-store',
      'expo-web-browser',
      'expo-camera',
      'expo-image-picker',
      'expo-apple-authentication',
      ['expo-notifications', { color: '#3b82f6' }],
      [
        'expo-splash-screen',
        {
          image: './assets/splash-icon.png',
          backgroundColor: '#5664e2',
          imageWidth: 200,
          resizeMode: 'contain',
        },
      ],
    ],
  },
};
