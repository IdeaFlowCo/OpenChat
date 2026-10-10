import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listStoryFeed: vi.fn(), openStory: vi.fn(), social: { enhanced: true } }));

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return {
    Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'), TouchableOpacity: host('TouchableOpacity'), View: host('View'),
  };
});
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/SocialExperienceContext', () => ({ useSocialExperience: () => mocks.social }));
vi.mock('../../mobile/src/theme/colors', () => ({ getColors: () => ({ surface: '#fff', surfaceElevated: '#eee', border: '#ccc', divider: '#ddd', textPrimary: '#123', textMetadata: '#456' }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: { listStoryFeed: mocks.listStoryFeed } }));

import { askTimeLeft, ProfileAsks } from '../../mobile/src/components/ProfileAsks.js';

const story = (id: string, authorId: string, text: string) => ({
  id, author: { id: authorId, name: 'Bob' }, text, storyExpiresAt: '2099-01-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z',
});
let root: ReturnType<typeof create> | undefined;
const texts = () => root!.root.findAllByType('Text').map(node => [node.props.children].flat(Infinity).filter(child => typeof child === 'string').join('')).join('\n');
const buttons = (label: string): ReactTestInstance[] => root!.root.findAllByType('TouchableOpacity')
  .filter(node => node.findAllByType('Text').some(text => [text.props.children].flat(Infinity).join('').includes(label)));
const mount = async () => { await act(async () => { root = create(React.createElement(ProfileAsks, { userId: 'bob', onOpenStory: mocks.openStory })); }); };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.social.enhanced = true;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe('asks on a contact profile', () => {
  it('lists only this person’s shared asks and opens one to respond', async () => {
    const first = story('s1', 'bob', 'Looking for grid-storage founders');
    mocks.listStoryFeed.mockResolvedValue([first, story('s2', 'carol', 'Someone else’s ask'), story('s3', 'bob', 'Hiring in Oakland?')]);
    await mount();
    expect(mocks.listStoryFeed).toHaveBeenCalledWith('bob');
    expect(texts()).toContain('Shared with you · 2');
    expect(texts()).toContain('Looking for grid-storage founders');
    expect(texts()).toContain('Hiring in Oakland?');
    expect(texts()).not.toContain('Someone else’s ask');
    await act(async () => { buttons('Respond')[0]!.props.onPress(); });
    expect(mocks.openStory).toHaveBeenCalledWith(first);
  });

  it('adds no section when nothing is shared', async () => {
    mocks.listStoryFeed.mockResolvedValue([]);
    await mount();
    expect(root!.toJSON()).toBeNull();
  });

  it('shows nothing when the feed fails or the coordination layer is off', async () => {
    mocks.listStoryFeed.mockRejectedValue(new Error('offline'));
    await mount();
    expect(root!.toJSON()).toBeNull();
    await act(async () => { root!.unmount(); });

    mocks.social.enhanced = false;
    mocks.listStoryFeed.mockClear();
    await mount();
    expect(root!.toJSON()).toBeNull();
    expect(mocks.listStoryFeed).not.toHaveBeenCalled();
  });

  it('words the time left plainly', () => {
    const now = Date.parse('2026-10-02T00:00:00Z');
    expect(askTimeLeft('2026-10-02T00:30:00Z', now)).toBe('1 hour left');
    expect(askTimeLeft('2026-10-02T05:00:00Z', now)).toBe('5 hours left');
    expect(askTimeLeft('2026-10-04T00:00:00Z', now)).toBe('2 days left');
    expect(askTimeLeft('2020-01-01T00:00:00Z', now)).toBe('0 hours left');
  });
});
