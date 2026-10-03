import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  focused: true,
  user: { userId: 'alice' } as { userId: string } | null,
  platform: { OS: 'ios' },
  getMyCard: vi.fn(), getAccess: vi.fn(), choose: vi.fn(), more: vi.fn(),
  share: vi.fn(), openURL: vi.fn(), copy: vi.fn(),
  foreground: undefined as undefined | ((state: string) => void),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', Text: 'Text',
  TouchableOpacity: 'TouchableOpacity', View: 'View', Switch: 'Switch', TextInput: 'TextInput',
  Platform: mocks.platform, StyleSheet: { create: (value: unknown) => value },
  useWindowDimensions: () => ({ width: 390 }),
  AppState: { addEventListener: (_: string, listener: (state: string) => void) => {
    mocks.foreground = listener;
    return { remove: () => { mocks.foreground = undefined; } };
  } },
  Share: { share: mocks.share }, Linking: { openURL: mocks.openURL }, Alert: { alert: vi.fn() },
}));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    React.useEffect(() => mocks.focused ? callback() : undefined, [callback, mocks.focused]);
  },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.copy }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: mocks.user }) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/components/AddMeCardView', () => ({ AddMeCardView: ({ card }: any) => React.createElement('Text', null, card.name) }));
vi.mock('../../mobile/src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
vi.mock('../../mobile/src/api/client', () => ({
  api: { getMyCard: mocks.getMyCard },
  addMeCardUrl: (token: string) => `https://chat.globalbr.ai/c/${token}`,
}));
// Switch account (Ideaflow config fetch) is covered by the Ideaflow tests.
vi.mock('../../mobile/src/hooks/useIdeaflowAccountSwitch', () => ({
  useIdeaflowAccountSwitch: () => ({ available: false, switching: false, switchAccount: async () => {} }),
}));
vi.mock('../../mobile/src/utils/deviceContactInvite', () => ({
  getContactAccess: mocks.getAccess, chooseOneContact: mocks.choose, allowMoreContacts: mocks.more,
}));

import { InvitePersonScreen } from '../../mobile/src/screens/InvitePersonScreen';
import { MyCardScreen } from '../../mobile/src/screens/MyCardScreen';

let screen: ReturnType<typeof create> | undefined;
let component = InvitePersonScreen;
const card = (token = 'ALICE') => ({ token, settings: {}, preview: { name: token } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function render() {
  await act(async () => {
    if (screen) screen.update(React.createElement(component));
    else screen = create(React.createElement(component));
  });
}
const text = () => JSON.stringify(screen!.toJSON());
function button(label: string): ReactTestInstance {
  return screen!.root.findAllByType('TouchableOpacity' as any).find(node =>
    node.findAllByType('Text' as any).some(child => child.props.children === label),
  )!;
}
function press(label: string) {
  const target = button(label);
  expect(target).toBeDefined();
  expect(target.props.disabled).not.toBe(true);
  return target.props.onPress();
}

beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.focused = true;
  mocks.user = { userId: 'alice' };
  mocks.platform.OS = 'ios';
  mocks.getMyCard.mockResolvedValue(card());
  mocks.getAccess.mockResolvedValue('all');
  mocks.choose.mockResolvedValue('Synthetic Recipient');
  mocks.more.mockResolvedValue('limited');
  component = InvitePersonScreen;
});
afterEach(async () => {
  await act(async () => { screen?.unmount(); });
  screen = undefined;
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe('individual contact invitation lifecycle', () => {
  it('asks permission only on action and shares only the freshly resolved public link', async () => {
    mocks.getAccess.mockResolvedValueOnce('not_requested').mockResolvedValue('limited');
    await render();
    expect(mocks.getAccess).toHaveBeenCalledWith();
    expect(mocks.choose).not.toHaveBeenCalled();
    await act(async () => { press('Choose from Contacts'); });
    expect(mocks.getAccess).toHaveBeenLastCalledWith(true);
    expect(text()).toContain('Synthetic Recipient');
    expect(button('Allow more contacts')).toBeDefined();
    mocks.getMyCard.mockResolvedValue(card('ROTATED'));
    await act(async () => { press('Share invitation'); });
    expect(mocks.share).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.share.mock.calls)).toContain('/c/ROTATED');
    expect(JSON.stringify(mocks.share.mock.calls)).not.toContain('Synthetic Recipient');
    expect(text()).not.toContain('Synthetic Recipient');
  });

  it.each(['denied', 'unavailable'])('keeps share and copy usable with %s access', async access => {
    mocks.getAccess.mockResolvedValue(access);
    await render();
    expect(button('Choose one contact')).toBeUndefined();
    await act(async () => { press('Copy link'); });
    expect(mocks.copy).toHaveBeenCalledWith('https://chat.globalbr.ai/c/ALICE');
    expect(mocks.choose).not.toHaveBeenCalled();
  });

  it('uses honest browser fallback without a Contacts button', async () => {
    mocks.platform.OS = 'web';
    mocks.getAccess.mockResolvedValue('unavailable');
    await render();
    expect(text()).toContain('Browsers cannot open your address book');
    expect(button('Choose from Contacts')).toBeUndefined();
    expect(button('Share invitation')).toBeDefined();
  });

  it('discards a picker result delivered after leaving and returning to the screen', async () => {
    const picker = deferred<string>();
    mocks.choose.mockReturnValue(picker.promise);
    await render();
    await act(async () => { press('Choose one contact'); });
    mocks.focused = false;
    await render();
    mocks.focused = true;
    await render();
    await act(async () => { picker.resolve('Late private name'); });
    expect(text()).not.toContain('Late private name');
  });

  it('clears contact data on account switch and logout, including a pending picker', async () => {
    await render();
    await act(async () => { press('Choose one contact'); });
    expect(text()).toContain('Synthetic Recipient');
    const picker = deferred<string>();
    mocks.choose.mockReturnValue(picker.promise);
    await act(async () => { press('Choose one contact'); });
    mocks.user = { userId: 'bob' };
    mocks.getMyCard.mockResolvedValue(card('BOB'));
    await render();
    expect(text()).not.toContain('Synthetic Recipient');
    mocks.user = null;
    await render();
    await act(async () => { picker.resolve('Late private name'); });
    expect(text()).not.toContain('Late private name');
    expect(text()).not.toContain('/c/BOB');
  });

  it('clears the selected name and refreshes permissions when returning from Settings', async () => {
    await render();
    await act(async () => { press('Choose one contact'); });
    mocks.getAccess.mockResolvedValue('denied');
    await act(async () => { mocks.foreground?.('active'); });
    expect(text()).not.toContain('Synthetic Recipient');
    expect(text()).toContain('Contacts access is off');
  });

  it('does not apply an old limited-access picker result to another account', async () => {
    mocks.getAccess.mockResolvedValue('limited');
    const picker = deferred<string>();
    mocks.more.mockReturnValue(picker.promise);
    await render();
    await act(async () => { press('Allow more contacts'); });
    mocks.user = { userId: 'bob' };
    mocks.getAccess.mockResolvedValue('all');
    mocks.getMyCard.mockResolvedValue(card('BOB'));
    await render();
    await act(async () => { picker.resolve('denied'); });
    expect(button('Choose one contact')).toBeDefined();
    expect(text()).toContain('/c/BOB');
    expect(text()).not.toContain('Contacts access is off');
  });

  it.each(['blur', 'account', 'logout'])('cancels a pending external handoff on %s', async reason => {
    await render();
    const request = deferred<ReturnType<typeof card>>();
    mocks.getMyCard.mockReturnValue(request.promise);
    await act(async () => { press('Open in WhatsApp'); });
    if (reason === 'blur') mocks.focused = false;
    else mocks.user = reason === 'logout' ? null : { userId: 'bob' };
    await render();
    await act(async () => { request.resolve(card()); });
    expect(mocks.openURL).not.toHaveBeenCalled();
  });
});

describe('My card sharing lifecycle', () => {
  it.each([
    ['blur', 'Open in WhatsApp'], ['account', 'Open in WhatsApp'], ['logout', 'Open in WhatsApp'],
    ['blur', 'Share card link'], ['account', 'Share card link'], ['logout', 'Share card link'],
  ])('cancels a pending %s handoff from %s', async (reason, label) => {
    component = MyCardScreen;
    await render();
    const request = deferred<ReturnType<typeof card>>();
    mocks.getMyCard.mockReturnValue(request.promise);
    let pending: Promise<void>;
    await act(async () => { pending = press(label); });
    if (reason === 'blur') mocks.focused = false;
    else mocks.user = reason === 'logout' ? null : { userId: 'bob' };
    await render();
    await act(async () => { request.resolve(card()); await pending; });
    expect(mocks.openURL).not.toHaveBeenCalled();
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.copy).not.toHaveBeenCalled();
  });
});
