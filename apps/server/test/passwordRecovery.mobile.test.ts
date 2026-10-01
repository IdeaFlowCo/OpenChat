import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getColors } from '../../mobile/src/theme/colors';
const mocks = vi.hoisted(() => ({ openURL: vi.fn() }));
vi.mock('react-native', () => ({ Linking: { openURL: mocks.openURL }, Platform: { OS: 'web' },
  StyleSheet: { create: (styles: unknown) => styles }, View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity' }));
import { APPLE_ACCOUNT_RECOVERY_URL, GOOGLE_ACCOUNT_RECOVERY_URL, PasswordRecoveryHelp } from '../../mobile/src/components/PasswordRecoveryHelp';
let screen: ReturnType<typeof create> | undefined;
async function render(url: string | null = null) {
  await act(async () => { screen = create(React.createElement(PasswordRecoveryHelp, { colors: getColors('light'), providerResetUrl: url })); });
  await act(async () => { screen!.root.findByProps({ accessibilityLabel: 'Forgot password?' }).props.onPress(); });
}
const text = () => screen!.root.findAllByType('Text' as any).map(node => node.props.children).join(' ');
const pressLink = async (label: string) => {
  const link = screen!.root.findAllByProps({ accessibilityRole: 'link' }).find(node =>
    node.findAllByType('Text' as any).some(text => text.props.children === label));
  expect(link).toBeDefined();
  await act(async () => { await link!.props.onPress(); });
};
beforeEach(() => { vi.clearAllMocks(); mocks.openURL.mockResolvedValue(undefined); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => { screen?.unmount(); }); screen = undefined; delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
describe('shared native and responsive-web recovery help', () => {
  it('explains distinct methods and keeps unavailable provider recovery off', async () => {
    await render();
    expect(text()).toContain('Google-only account has no OpenChat password');
    expect(text()).toContain('existing Noos account');
    expect(text()).toContain('not available in OpenChat yet');
    expect(text()).not.toContain('Reset Ideaflow ID password');
    expect(mocks.openURL).not.toHaveBeenCalled();
    expect(screen!.root.findByProps({ accessibilityLabel: 'Forgot password?' }).props.accessibilityState.expanded).toBe(true);
  });
  it('opens Google recovery without forwarding identity or starting account creation', async () => {
    await render(); await pressLink('Recover your Google account');
    expect(mocks.openURL).toHaveBeenCalledExactlyOnceWith(GOOGLE_ACCOUNT_RECOVERY_URL);
  });
  it('routes Apple-only users to Apple without suggesting an Ideaflow password', async () => {
    await render(); expect(text()).toContain('Apple-only account has no OpenChat password');
    await pressLink('Recover your Apple account');
    expect(mocks.openURL).toHaveBeenCalledExactlyOnceWith(APPLE_ACCOUNT_RECOVERY_URL);
  });
  it('opens explicitly supplied provider recovery and states it does not reset Noos', async () => {
    const url = 'https://id.example/forgot-password'; await render(url);
    expect(text()).toContain('does not reset a Noos password or link accounts');
    await pressLink('Reset Ideaflow ID password'); expect(mocks.openURL).toHaveBeenCalledExactlyOnceWith(url);
  });
  it('shows opening failure and permits retry', async () => {
    mocks.openURL.mockRejectedValueOnce(new Error('browser unavailable')); await render();
    await pressLink('Recover your Google account');
    expect(screen!.root.findByProps({ accessibilityRole: 'alert' }).props.children).toContain('Please try again');
    await pressLink('Recover your Google account'); expect(screen!.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
  });
});
