import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// OpenChat-3ar0: "I literally can't even figure out how to log out of OpenChat
// on the web." Sign out must be reachable from the one "Me" door (the avatar →
// Profile) on every width, and from the top Account card in Settings — and the
// Profile menu must survive a failed card request.

const mocks = vi.hoisted(() => ({
  navigation: { navigate: vi.fn(), getState: () => ({ routes: [{ name: 'Conversations' }] }), goBack: vi.fn() },
  signOut: vi.fn(async () => {}),
  getMyCard: vi.fn(),
  currentUser: { userId: 'u1', name: 'Jacob', email: 'jacob@example.com' } as Record<string, unknown> | null,
  ideaflowEnabled: false,
  events: [] as string[],
  fetch: vi.fn(),
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  const el = (tag: string) => ({ children, ...props }: any) => React.createElement(tag, props, children);
  return {
    Platform: { OS: 'web', select: (values: any) => values.web ?? values.default },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Alert: { alert: vi.fn() },
    Clipboard: { setString: vi.fn() },
    Linking: { openURL: vi.fn(), openSettings: vi.fn() },
    Share: { share: vi.fn() },
    useWindowDimensions: () => ({ width: 1280, height: 800 }),
    Animated: {
      Value: class { constructor(public v: number) {} setValue() {} },
      View: el('AnimatedView'),
      timing: () => ({ start: () => {} }),
    },
    ActivityIndicator: 'ActivityIndicator',
    Pressable: el('Pressable'),
    Modal: ({ visible, children }: any) => (visible ? children : null),
    ScrollView: el('ScrollView'),
    Switch: el('Switch'),
    Text: el('Text'),
    TextInput: el('TextInput'),
    TouchableOpacity: el('TouchableOpacity'),
    View: el('View'),
  };
});
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-notifications', () => ({ getPermissionsAsync: vi.fn() }));
vi.mock('expo-updates', () => ({ channel: 'production', runtimeVersion: '1', isEnabled: false, isEmbeddedLaunch: true, updateId: null }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '9.9.9', extra: {} } } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { clear: vi.fn(), getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) } }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => mocks.navigation,
  useFocusEffect: vi.fn(),
}));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light', preference: 'system', setPreference: vi.fn() }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({
  useChat: () => ({
    currentUser: mocks.currentUser, isConnected: true, refreshConversations: vi.fn(), signOut: mocks.signOut,
    activeConversationId: null, setActiveConversation: vi.fn(), conversationsLoaded: true, conversations: [],
  }),
}));
vi.mock('../../mobile/src/contexts/SocialExperienceContext', () => ({
  useSocialExperience: () => ({
    enhanced: false,
    preferences: { experienceMode: 'simple', networkPaused: false },
    layoutPreference: 'auto',
    storiesCollapsed: false,
    setExperienceMode: vi.fn(),
    setNetworkPaused: vi.fn(),
    setLayoutPreference: vi.fn(),
    setStoriesCollapsed: vi.fn(),
  }),
}));
vi.mock('../../mobile/src/theme/colors', () => ({ getColors: () => new Proxy({}, { get: () => '#000' }) }));
vi.mock('../../mobile/src/api/client', () => ({
  OPENCHAT_URL: 'https://chat.ideaflow.app',
  addMeCardUrl: (token: string) => `https://chat.ideaflow.app/c/${token}`,
  clearSession: vi.fn(),
  api: { getMyCard: mocks.getMyCard },
}));
vi.mock('../../mobile/src/services/notifications', () => ({ registerForPushNotificationsAsync: vi.fn() }));
vi.mock('../../mobile/src/services/exportDownload', () => ({ saveJsonDownload: vi.fn() }));
vi.mock('../../mobile/src/components/AddMeCardView', () => ({ AddMeCardView: () => null }));
vi.mock('../../mobile/src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
vi.mock('../../mobile/src/components/ConversationList', () => ({ ConversationList: () => null }));
vi.mock('../../mobile/src/components/AgentOverlayButton', () => ({ AgentOverlayButton: () => null }));
vi.mock('../../mobile/src/components/ConnectionStatusLine', () => ({ ConnectionStatusLine: () => null }));
vi.mock('../../mobile/src/screens/ChatScreen', () => ({ ChatScreen: () => null }));
vi.mock('../../mobile/src/screens/AgentOverlayScreen', () => ({ AgentOverlayScreen: () => null }));
vi.mock('../../mobile/src/components/ExportSheet', () => ({ ExportSheet: () => null }));
vi.mock('../../mobile/src/components/FeedbackModal', () => ({ FeedbackModal: () => null }));
vi.mock('../../mobile/src/utils/cardSharing', () => ({ currentCardUrl: vi.fn(), shareCard: vi.fn(), shareCardOnWhatsApp: vi.fn() }));

import { MyCardScreen } from '../../mobile/src/screens/MyCardScreen.js';
import { SettingsScreen } from '../../mobile/src/screens/SettingsScreen.js';
import { MasterDetailLayout } from '../../mobile/src/components/MasterDetailLayout.js';

const CARD = {
  token: 'tok',
  preview: { name: 'Jacob' },
  settings: {
    showAvatar: true, showHeadline: false, showLinkedIn: false, showX: false, showLink: false,
    headline: null, linkedIn: null, x: null, link: null,
  },
};

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function textOf(node: ReactTestInstance): string {
  return node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
}

function buttonLabelled(root: ReactTestInstance, label: string): ReactTestInstance {
  const matches = root.findAll(n => n.type === 'TouchableOpacity' && n.props.accessibilityLabel === label);
  expect(matches, `exactly one "${label}" button`).toHaveLength(1);
  return matches[0];
}

function hasText(root: ReactTestInstance, text: string): boolean {
  return root.findAll(n => n.type === 'Text' && textOf(n) === text).length > 0;
}

/** Depth-first order of Text nodes, so "above" / "below" can be asserted. */
function textOrder(root: ReactTestInstance): string[] {
  return root.findAll(n => n.type === 'Text').map(textOf);
}

const AUTHORIZE_URL = 'https://id.ideaflow.app/api/auth/oauth2/authorize?client_id=openchat-web';

beforeEach(() => {
  mocks.currentUser = { userId: 'u1', name: 'Jacob', email: 'jacob@example.com' };
  mocks.ideaflowEnabled = false;
  mocks.events = [];
  mocks.signOut.mockImplementation(async () => { mocks.events.push('signOut'); });
  mocks.fetch.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/ideaflow/config') {
      return new Response(JSON.stringify({ enabled: mocks.ideaflowEnabled }), { status: 200 });
    }
    if (url.pathname === '/api/auth/ideaflow/url') {
      mocks.events.push(`start:${url.searchParams.get('prompt')}`);
      return new Response(JSON.stringify({ url: AUTHORIZE_URL }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

/** Browser globals for the web-only Switch account path. */
function stubBrowser() {
  const store = new Map<string, string>();
  const storage = { setItem: (k: string, v: string) => { store.set(k, v); }, getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => { store.delete(k); } };
  const assign = vi.fn((url: string) => { mocks.events.push(`navigate:${url}`); });
  const alert = vi.fn();
  vi.stubGlobal('window', { location: { assign, origin: 'https://chat.ideaflow.app' }, sessionStorage: storage, alert });
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  return { store, assign, alert };
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
async function settleUntil(condition: () => boolean, attempts = 50) {
  for (let i = 0; i < attempts && !condition(); i++) await settle();
}

describe('Profile (MyCard) sign out', () => {
  it('offers Sign out and Settings even when the card request fails', async () => {
    mocks.getMyCard.mockRejectedValueOnce(new Error('boom'));
    const tree = create(React.createElement(MyCardScreen));
    await flush();

    expect(hasText(tree.root, 'Could not load your card.')).toBe(true);
    expect(hasText(tree.root, 'Settings')).toBe(true);
    expect(hasText(tree.root, 'Reset card link')).toBe(false);

    const signOut = buttonLabelled(tree.root, 'Sign out');
    expect(hasText(signOut, 'Signed in as jacob@example.com')).toBe(true);
    await act(async () => { signOut.props.onPress(); });
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it('offers Sign out alongside the card once it loads', async () => {
    mocks.getMyCard.mockResolvedValueOnce(CARD);
    const tree = create(React.createElement(MyCardScreen));
    await flush();

    expect(hasText(tree.root, 'Reset card link')).toBe(true);
    const signOut = buttonLabelled(tree.root, 'Sign out');
    await act(async () => { signOut.props.onPress(); });
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('Settings sign out', () => {
  it('keeps Sign out in the top Account card, above the legal/danger rows', async () => {
    const tree = create(React.createElement(SettingsScreen));
    await flush();

    const order = textOrder(tree.root);
    const account = order.indexOf('ACCOUNT');
    const signOut = order.indexOf('Sign out');
    const experience = order.indexOf('EXPERIENCE');
    const deleteAccount = order.indexOf('Delete my account');
    expect(account).toBeGreaterThanOrEqual(0);
    expect(signOut).toBeGreaterThan(account);
    expect(signOut).toBeLessThan(experience);
    expect(signOut).toBeLessThan(deleteAccount);
    expect(order.filter(t => t === 'Sign out')).toHaveLength(1);

    await act(async () => { buttonLabelled(tree.root, 'Sign out').props.onPress(); });
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it('still offers Sign out when the session has no loaded user', async () => {
    mocks.currentUser = null;
    const tree = create(React.createElement(SettingsScreen));
    await flush();
    expect(hasText(tree.root, 'Edit profile')).toBe(false);
    buttonLabelled(tree.root, 'Sign out');
  });
});

describe('Desktop sidebar account menu', () => {
  const menuItems = (root: ReactTestInstance) =>
    root.findAll(n => n.type === 'Pressable' && n.props.accessibilityRole === 'menuitem').map(n => n.props.accessibilityLabel);

  it('opens Profile / Settings / Sign out from the avatar, and Sign out signs out', async () => {
    const tree = create(React.createElement(MasterDetailLayout));
    await flush();
    expect(menuItems(tree.root)).toEqual([]);

    const avatar = buttonLabelled(tree.root, 'Account menu');
    await act(async () => { avatar.props.onPress(); });
    expect(menuItems(tree.root)).toEqual(['Profile', 'Settings', 'Sign out']);
    expect(hasText(tree.root, 'jacob@example.com')).toBe(true);

    const signOut = tree.root.find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Sign out');
    await act(async () => { signOut.props.onPress(); });
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(menuItems(tree.root)).toEqual([]);
  });

  it('routes Profile and Settings to their screens and closes the menu', async () => {
    const tree = create(React.createElement(MasterDetailLayout));
    await flush();
    for (const [label, route] of [['Profile', 'MyCard'], ['Settings', 'Settings']] as const) {
      await act(async () => { buttonLabelled(tree.root, 'Account menu').props.onPress(); });
      const item = tree.root.find(n => n.type === 'Pressable' && n.props.accessibilityLabel === label);
      await act(async () => { item.props.onPress(); });
      expect(mocks.navigation.navigate).toHaveBeenLastCalledWith(route);
      expect(menuItems(tree.root)).toEqual([]);
    }
  });
});

describe('Switch account (web, Ideaflow ID enabled)', () => {
  const menuItems = (root: ReactTestInstance) =>
    root.findAll(n => n.type === 'Pressable' && n.props.accessibilityRole === 'menuitem').map(n => n.props.accessibilityLabel);

  it('desktop account menu signs out locally, then starts Ideaflow with prompt=select_account', async () => {
    mocks.ideaflowEnabled = true;
    const { store } = stubBrowser();
    const tree = create(React.createElement(MasterDetailLayout));
    await settle();

    await act(async () => { buttonLabelled(tree.root, 'Account menu').props.onPress(); });
    expect(menuItems(tree.root)).toEqual(['Profile', 'Settings', 'Switch account', 'Sign out']);

    const item = tree.root.find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Switch account');
    await act(async () => { item.props.onPress(); });
    await settleUntil(() => mocks.events.length >= 3);

    expect(mocks.events).toEqual(['start:select_account', 'signOut', `navigate:${AUTHORIZE_URL}`]);
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.get('openchat_ideaflow_web')!)).toEqual(expect.objectContaining({
      state: expect.any(String), nonce: expect.any(String), codeVerifier: expect.any(String),
    }));
    expect(menuItems(tree.root)).toEqual([]);
  });

  it('Profile offers Switch account above Sign out and uses the same chooser path', async () => {
    mocks.ideaflowEnabled = true;
    mocks.getMyCard.mockResolvedValueOnce(CARD);
    stubBrowser();
    const tree = create(React.createElement(MyCardScreen));
    await settle();

    const order = textOrder(tree.root);
    expect(order.indexOf('Switch account')).toBeGreaterThan(order.indexOf('ACCOUNT'));
    expect(order.indexOf('Switch account')).toBeLessThan(order.indexOf('Sign out'));
    await act(async () => { buttonLabelled(tree.root, 'Switch account').props.onPress(); });
    await settleUntil(() => mocks.events.length >= 3);
    expect(mocks.events).toEqual(['start:select_account', 'signOut', `navigate:${AUTHORIZE_URL}`]);
  });

  it('stays signed in and explains when the provider cannot be reached', async () => {
    mocks.ideaflowEnabled = true;
    const { assign, alert } = stubBrowser();
    mocks.fetch.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/api/auth/ideaflow/config') return new Response(JSON.stringify({ enabled: true }), { status: 200 });
      return new Response(JSON.stringify({ error: 'Could not reach Ideaflow ID' }), { status: 502 });
    });
    const tree = create(React.createElement(MasterDetailLayout));
    await settle();
    await act(async () => { buttonLabelled(tree.root, 'Account menu').props.onPress(); });
    const item = tree.root.find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Switch account');
    await act(async () => { item.props.onPress(); });
    await settleUntil(() => alert.mock.calls.length > 0);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith("Could not switch account. Couldn't reach Ideaflow. Please try again in a moment.");
  });

  it('is absent when Ideaflow ID is disabled, leaving Sign out unchanged', async () => {
    stubBrowser();
    const tree = create(React.createElement(MasterDetailLayout));
    await settle();
    await act(async () => { buttonLabelled(tree.root, 'Account menu').props.onPress(); });
    expect(menuItems(tree.root)).toEqual(['Profile', 'Settings', 'Sign out']);
  });
});
