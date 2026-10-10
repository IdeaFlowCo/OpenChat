import { describe, expect, it } from 'vitest';
import { dedupeLinkPreviews } from './linkPreviews';

const p = (url: string, title?: string, siteName?: string) => ({ url, title, siteName, fetchedAt: '2026-10-10T00:00:00Z' });

describe('dedupeLinkPreviews', () => {
  it('keeps one card per page and per identical title', () => {
    const out = dedupeLinkPreviews([
      p('https://worldissuetracker.com/', 'Issue Tracker for Society', 'WIT'),
      p('https://www.worldissuetracker.com', 'Issue Tracker for Society', 'WIT'),
      p('https://worldissuetracker.com/#top'),
      p('https://worldissuetracker.com/about', 'About'),
    ]);
    expect(out.map(x => x.url)).toEqual(['https://worldissuetracker.com/', 'https://worldissuetracker.com/about']);
  });
});
