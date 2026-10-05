import { describe, expect, it } from 'vitest';
import { parseOpenChatUrl } from '../../mobile/src/utils/parseOpenChatUrl';
const entry = (params: Record<string, string>) => `https://chat.ideaflow.app/app/?${new URLSearchParams({ intent: 'compose', source: 'unlinked', ...params })}`;
describe('Unlinked compose receiving contract', () => {
  it('keeps no recipient when only public profile context is supplied', () => {
    expect(parseOpenChatUrl(entry({ profile: 'https://www.unlinked.ai/people/public-id' }))).toEqual({ type: 'compose', source: 'unlinked', profile: 'https://www.unlinked.ai/people/public-id' });
    expect(parseOpenChatUrl(entry({}))).toEqual({ type: 'compose', source: 'unlinked' });
  });
  it.each(['https://private.unlinked.ai/people/a', 'https://www.unlinked.ai/people/a?email=secret', 'https://www.unlinked.ai/people/../a', 'https://www.unlinked.ai/people/%2Fprivate', 'https://www.unlinked.ai/people/%ZZ', 'https://www.unlinked.ai/people/a#private', 'https://www.unlinked.ai@evil.test/people/a'])('rejects unsafe context %s', profile => {
    expect(parseOpenChatUrl(entry({ profile }))).toEqual({ type: 'unknown' });
  });
  it('allows only the real-card token grammar without inventing identity', () => {
    expect(parseOpenChatUrl(entry({ card: 'a'.repeat(24) }))).toEqual({ type: 'compose', source: 'unlinked', card: 'a'.repeat(24) });
    expect(parseOpenChatUrl(entry({ card: 'person-id' }))).toEqual({ type: 'unknown' });
    expect(parseOpenChatUrl(entry({ email: 'private@example.test' }))).toEqual({ type: 'unknown' });
    expect(parseOpenChatUrl(entry({}) + '&source=other')).toEqual({ type: 'unknown' });
  });
});
