import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setQuery: null as null | ((q: string) => void),
  fetchThoughts: vi.fn(),
  searchVision: vi.fn(),
  updateThought: vi.fn(),
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
    Appearance: { getColorScheme: () => 'light' },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Alert: { alert: vi.fn() },
    Linking: { openURL: vi.fn(async () => true) },
    ActivityIndicator: 'ActivityIndicator',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    View: 'View',
    RefreshControl: () => null,
    FlatList: ({ data, renderItem, ListEmptyComponent, ListHeaderComponent, ListFooterComponent }: any) =>
      React.createElement(
        'FlatList', null, ListHeaderComponent,
        data && data.length
          ? data.map((item: any, index: number) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item, index })))
          : ListEmptyComponent,
        ListFooterComponent
      ),
  };
});
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
  useFocusEffect: (cb: any) => { React.useEffect(() => { cb(); }, [cb]); },
}));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: 'alice' } }) }));
vi.mock('../../mobile/src/api/socket', () => ({ getSocket: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
vi.mock('../../mobile/src/components/StreamEditor', () => ({
  StreamEditor: (props: any) => React.createElement('StreamEditor', { ...props, testID: 'stream-editor' }),
}));
vi.mock('../../mobile/src/components/StreamCompactToggle', () => ({ StreamCompactToggle: () => null }));
vi.mock('../../mobile/src/components/ThoughtsSearchBar', () => ({
  ThoughtsSearchBar: ({ onChangeText }: any) => { mocks.setQuery = onChangeText; return null; },
}));
vi.mock('../../mobile/src/components/ThoughtCard', () => ({
  ThoughtCard: ({ item, onPress }: any) => React.createElement('Text', { testID: 'local-card', onPress }, item.text),
  formatRelativeTime: () => 'now',
}));
vi.mock('../../mobile/src/services/streamDisplay', () => ({ applyCollapsed: vi.fn(), ingestStreamCollapsed: vi.fn() }));
vi.mock('../../mobile/src/services/thoughts', () => ({
  fetchThoughts: (...a: any[]) => mocks.fetchThoughts(...a),
  searchVision: (...a: any[]) => mocks.searchVision(...a),
  createThought: vi.fn(), updateThought: (...a: any[]) => mocks.updateThought(...a), deleteThought: vi.fn(),
}));

import { ThoughtsScreen } from '../../mobile/src/screens/ThoughtsScreen.js';

const local = { id: 't1', text: 'local note', kind: 'observation', status: 'none', createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z' };
const visionRow = { id: 'v1', text: 'vision note', title: null, createdAt: '2026-06-01T00:00:00Z', url: 'https://vision.ideaflow.app/n/v1', sourcePlatform: null, sourceLink: null, tags: [] };

describe('ThoughtsScreen Vision search', () => {
  let screen: ReturnType<typeof create> | undefined;
  const byTestId = (id: string) => screen!.root.findAll((n) => n.props?.testID === id && typeof n.type === 'string');
  const type = async (q: string) => {
    await act(async () => { mocks.setQuery!(q); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.fetchThoughts.mockResolvedValue([local]);
    await act(async () => { screen = create(React.createElement(ThoughtsScreen)); });
  });
  afterEach(async () => {
    await act(async () => { screen?.unmount(); });
    screen = undefined;
    vi.useRealTimers();
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows chips and merges Vision rows with local results when Vision is available', async () => {
    mocks.searchVision.mockResolvedValue({ status: 'ok', rows: [visionRow], nextCursor: null });
    expect(byTestId('vision-chip-openchat')).toHaveLength(0);
    await type('note');
    expect(mocks.searchVision).toHaveBeenCalledWith({ q: 'note', chip: 'openchat' }, expect.anything());
    expect(byTestId('vision-chip-openchat')).toHaveLength(1);
    expect(byTestId('vision-chip-all')).toHaveLength(1);
    expect(byTestId('vision-note-card')).toHaveLength(1);
    expect(byTestId('local-card')).toHaveLength(1);
    expect(byTestId('vision-unavailable-notice')).toHaveLength(0);
  });

  it('falls back to local search with a visible notice when Vision is degraded', async () => {
    mocks.searchVision.mockResolvedValue({ status: 'unavailable', code: 'timeout', reason: 'slow' });
    await type('note');
    const notice = byTestId('vision-unavailable-notice');
    expect(notice).toHaveLength(1);
    expect(notice[0].props.children).toBe('Vision unavailable — showing OpenChat Stream only');
    expect(byTestId('vision-chip-openchat')).toHaveLength(0);
    expect(byTestId('local-card')).toHaveLength(1);
    expect(byTestId('vision-note-card')).toHaveLength(0);
  });

  it('silently stops calling Vision when the user has no Vision', async () => {
    mocks.searchVision.mockResolvedValue({ status: 'unavailable', code: 'account_link_required', reason: '' });
    await type('no');
    await type('note');
    await type('notes');
    expect(mocks.searchVision).toHaveBeenCalledTimes(1);
    expect(byTestId('vision-unavailable-notice')).toHaveLength(0);
    expect(byTestId('vision-chip-openchat')).toHaveLength(0);
    expect(byTestId('local-card')).toHaveLength(1);
  });

  // Copy/select/edit audit 2026-11: an owned entry found by search is editable
  // in place and saves through the owner-only PATCH (updateThought).
  it('edits an owned Stream entry straight from search results', async () => {
    mocks.searchVision.mockResolvedValue({ status: 'ok', rows: [visionRow], nextCursor: null });
    mocks.updateThought.mockResolvedValue({ ...local, text: 'local note, edited' });
    await type('note');
    await act(async () => { byTestId('local-card')[0].props.onPress(); });
    const editor = () => screen!.root.findAll((n) => n.props?.testID === 'stream-editor' && n.type === 'StreamEditor')[0];
    expect(editor().props.value).toBe('local note');
    await act(async () => { editor().props.onChangeText('local note, edited'); });
    await act(async () => { await editor().props.onSave(); });
    expect(mocks.updateThought).toHaveBeenCalledWith('t1', { text: 'local note, edited' });
    expect(screen!.root.findAll((n) => n.props?.testID === 'stream-editor' && n.type === 'StreamEditor')).toHaveLength(0);
    expect(byTestId('local-card')[0].props.children).toBe('local note, edited');
  });
});
