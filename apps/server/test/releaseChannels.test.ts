import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('public client release channels', () => {
  it('presents React Native web as experimental and legacy web as out of date', () => {
    const landing = source('../src/landing.html');
    const server = source('../src/index.ts');

    expect(landing).toContain('Experimental React Native preview');
    expect(landing).toContain('Mobile web · Experimental');
    expect(landing).toContain('Desktop web · Experimental');
    expect(landing).toContain('older Vite client is out of date');
    expect(server).toContain('older web client is out of date and may be missing features');
  });

  it('does not advertise native downloads from public or in-app acquisition surfaces', () => {
    const surfaces = [
      source('../src/landing.html'),
      source('../src/index.ts'),
      source('../../web/src/components/SettingsModal.tsx'),
      source('../../mobile/src/screens/SettingsScreen.tsx'),
    ].join('\n');

    expect(surfaces).not.toContain('testflight.apple.com');
    expect(surfaces).not.toContain('expo.dev/artifacts');
    expect(surfaces).not.toContain('Join TestFlight');
    expect(surfaces).not.toContain('Download APK');
  });
});
