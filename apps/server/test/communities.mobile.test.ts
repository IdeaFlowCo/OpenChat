import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  chat: {} as Record<string, any>, route: { params: { communityId: 'co-a' } },
  navigation: { navigate: vi.fn() }, renderedText: [] as string[],
  api: {
    listCommunities: vi.fn(), getCommunity: vi.fn(), createCommunity: vi.fn(), joinCommunity: vi.fn(),
    createCommunityGroup: vi.fn(), linkCommunityGroup: vi.fn(), unlinkCommunityGroup: vi.fn(), joinCommunityGroup: vi.fn(),
    setCommunityMemberRole: vi.fn(), removeCommunityMember: vi.fn(), createCommunityInvite: vi.fn(), revokeCommunityInvites: vi.fn(), updateCommunity: vi.fn(),
  },
}));
vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 }, View: 'View', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator', TouchableOpacity: 'TouchableOpacity',
    Text: ({ children, ...props }: any) => { m.renderedText.push(String(children)); return React.createElement('Text', props, children); },
    ScrollView: React.forwardRef(({ children, ...props }: any, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollTo: vi.fn() }));
      return React.createElement('ScrollView', props, children);
    }),
  };
});
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => m.navigation, useRoute: () => m.route,
  useFocusEffect: (cb: any) => React.useEffect(cb, [cb]),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => m.chat }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: m.api }));
vi.mock('../../mobile/src/components/ui', () => ({ Button: 'Button', Card: 'Card', Chip: 'Chip', ListRow: (props: any) => React.createElement('ListRow', props, props.trailing), SectionLabel: 'SectionLabel' }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { CommunitiesScreen, CommunityScreen } from '../../mobile/src/screens/CommunitiesScreen';

const detail = (role = 'owner') => ({
  id: 'co-a', name: 'Synthetic community', description: 'Synthetic private description', role,
  announcementsId: 'ann-a', memberCount: 2,
  groups: [{ id: 'group-a', title: 'Synthetic group', joined: false }],
  members: [{ id: 'owner-a', name: 'Owner', role: 'owner' }, { id: 'member-b', name: 'Member', role: 'member' }],
});
let tree: ReactTestRenderer;
const button = (label: string) => tree.root.findAllByType('Button' as any).find(node => node.props.label === label)!;
async function press(label: string) { await act(async () => { button(label).props.onPress(); }); }
async function render(element: React.ReactElement) { await act(async () => { tree = create(element); }); }

beforeEach(() => {
  vi.clearAllMocks(); m.renderedText.length = 0; m.route.params.communityId = 'co-a';
  m.chat = { currentUser: { userId: 'owner-a' }, isIdentityVerified: true, communityRevision: 0,
    conversations: [], refreshConversations: vi.fn(async () => {}), setActiveConversation: vi.fn() };
  m.api.listCommunities.mockResolvedValue([]); m.api.getCommunity.mockImplementation(async () => detail());
  m.api.joinCommunityGroup.mockResolvedValue({ conversationId: 'group-a' });
  m.api.createCommunityInvite.mockResolvedValue({ token: 'synthetic-invite-code' });
});
afterEach(async () => { if (tree) await act(async () => { tree.unmount(); }); });

describe('community client access and explicit actions', () => {
  it('waits for verified identity before any private request', async () => {
    m.chat.isIdentityVerified = false;
    await render(React.createElement(CommunitiesScreen));
    expect(m.api.listCommunities).not.toHaveBeenCalled();
    m.chat.isIdentityVerified = true;
    await act(async () => tree.update(React.createElement(CommunitiesScreen)));
    expect(m.api.listCommunities).toHaveBeenCalledTimes(1);
  });
  it('discards old-owner and old-target content in every render during transition', async () => {
    await render(React.createElement(CommunityScreen));
    expect(m.renderedText).toContain('Synthetic community');
    m.renderedText.length = 0;
    m.chat.currentUser = { userId: 'new-owner' };
    m.api.getCommunity.mockImplementation(() => new Promise(() => {}));
    await act(async () => tree.update(React.createElement(CommunityScreen)));
    expect(m.renderedText.join(' ')).not.toContain('Synthetic private description');
    expect(m.renderedText.join(' ')).not.toContain('Synthetic community');
    m.renderedText.length = 0; m.route.params.communityId = 'co-b';
    await act(async () => tree.update(React.createElement(CommunityScreen)));
    expect(m.renderedText.join(' ')).not.toContain('Synthetic community');
  });
  it('hides cached community content immediately when realtime invalidation arrives', async () => {
    await render(React.createElement(CommunityScreen)); m.renderedText.length = 0;
    m.chat.communityRevision++;
    m.api.getCommunity.mockImplementation(() => new Promise(() => {}));
    await act(async () => tree.update(React.createElement(CommunityScreen)));
    expect(m.renderedText.join(' ')).not.toContain('Synthetic private description');
  });
  it('requires a separate confirmation before joining a group, then opens that chat', async () => {
    await render(React.createElement(CommunityScreen)); await press('Join group');
    expect(m.api.joinCommunityGroup).not.toHaveBeenCalled();
    expect(m.renderedText.join(' ')).toContain('can read its history');
    const confirm = tree.root.findByProps({ testID: 'community-confirmation' });
    await act(async () => { confirm.findAllByType('Button' as any)[0].props.onPress(); });
    expect(m.api.joinCommunityGroup).toHaveBeenCalledWith('co-a', 'group-a');
    expect(m.navigation.navigate).toHaveBeenCalledWith('Chat', { conversationId: 'group-a' });
  });
  it('shows member reading actions without admin or owner controls', async () => {
    m.api.getCommunity.mockResolvedValue(detail('member'));
    await render(React.createElement(CommunityScreen));
    expect(button('Create group')).toBeUndefined(); expect(button('Create invite code')).toBeUndefined();
    expect(button('Transfer ownership')).toBeUndefined(); expect(button('Leave community')).toBeDefined();
  });
  it('does not link an existing group until its history-sharing confirmation', async () => {
    m.chat.conversations = [{ id: 'owned', type: 'group', title: 'Owned group', participants: [{ user: { id: 'owner-a' }, role: 'owner' }] },
      { id: 'managed', type: 'group', title: 'Managed', unlinkedGroupId: 'unlinked', participants: [{ user: { id: 'owner-a' }, role: 'owner' }] }];
    await render(React.createElement(CommunityScreen)); await press('Link existing group');
    const row = tree.root.findAllByType('ListRow' as any).find(node => node.props.title === 'Owned group')!;
    expect(tree.root.findAllByType('ListRow' as any).some(node => node.props.title === 'Managed')).toBe(false);
    await act(async () => row.props.onPress());
    expect(m.api.linkCommunityGroup).not.toHaveBeenCalled();
    expect(m.renderedText.join(' ')).toContain('Nobody is added automatically');
    await press('Link group and allow joining');
    expect(m.api.linkCommunityGroup).toHaveBeenCalledWith('co-a', 'owned');
  });
  it('keeps a newly returned invite code visible after its own realtime refresh', async () => {
    await render(React.createElement(CommunityScreen)); await press('Create invite code');
    m.chat.communityRevision++;
    await act(async () => tree.update(React.createElement(CommunityScreen)));
    expect(m.renderedText).toContain('synthetic-invite-code');
    expect(button('Copy invite code')).toBeDefined();
  });
  it('ignores an old-account mutation result instead of navigating the new account', async () => {
    let resolve!: (value: any) => void;
    m.api.joinCommunity.mockImplementation(() => new Promise(r => { resolve = r; }));
    await render(React.createElement(CommunitiesScreen)); await press('Join with invite');
    const field = tree.root.findByProps({ accessibilityLabel: 'Community invite code' });
    await act(async () => field.props.onChangeText('synthetic-token'));
    await press('Join community');
    m.chat.currentUser = { userId: 'new-owner' };
    await act(async () => tree.update(React.createElement(CommunitiesScreen)));
    await act(async () => resolve(detail()));
    expect(m.navigation.navigate).not.toHaveBeenCalled();
  });
});

it('keeps an ownerless archived community readable while hiding invites and new child joins',async()=>{
 m.api.getCommunity.mockResolvedValue({...detail('member'),state:'archived'});
 await render(React.createElement(CommunityScreen));
 expect(m.renderedText.join(' ')).toContain('archived');
 expect(button('Join group')?.props.disabled).toBe(true);
 expect(button('Create invite')).toBeUndefined();expect(button('Add group')).toBeUndefined();
});
