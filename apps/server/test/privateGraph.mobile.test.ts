import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPrivatePerson: vi.fn(), updatePrivatePerson: vi.fn(), addPrivateNote: vi.fn(), deletePrivateNote: vi.fn(),
  addPrivateLink: vi.fn(), deletePrivateLink: vi.fn(), listPrivateThings: vi.fn(),
  openThing: vi.fn(), openPerson: vi.fn(),
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return {
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    ActivityIndicator: 'ActivityIndicator',
    Text: host('Text'), TextInput: host('TextInput'), TouchableOpacity: host('TouchableOpacity'), View: host('View'),
  };
});
vi.mock('../../mobile/src/components/ProfileNoteCapture', () => ({ ProfileNoteCapture: ({ notes }: any) => React.createElement('View', {}, notes.map((note: any) => React.createElement('Text', { key: note.id }, note.text))) }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/theme/colors', () => ({ getColors: () => ({ background: '#fff', surface: '#fff', surfaceElevated: '#eee', border: '#ccc', divider: '#ddd', primary: '#123', onPrimary: '#fff', textPrimary: '#123', textSecondary: '#456', textMetadata: '#456', textMuted: '#999', danger: '#c00' }) }));
vi.mock('../../mobile/src/api/client', () => ({
  api: {
    getProfileNoteReviews: vi.fn().mockResolvedValue({ reviews: [], asks: [] }), getPrivatePerson: mocks.getPrivatePerson, updatePrivatePerson: mocks.updatePrivatePerson, addPrivateNote: mocks.addPrivateNote,
    deletePrivateNote: mocks.deletePrivateNote, addPrivateLink: mocks.addPrivateLink, deletePrivateLink: mocks.deletePrivateLink, listPrivateThings: mocks.listPrivateThings,
  },
}));

import { cadenceLabel, dueLabel, PrivateCard, privateSummary } from '../../mobile/src/components/PrivateGraph.js';

const emptyCard = { important: false, cadenceDays: null, cadenceMode: 'fixed' as const, intervalDays: null, lastContactAt: null, nextDueAt: null };
let root: ReturnType<typeof create> | undefined;
const texts = () => root!.root.findAllByType('Text').map(node => [node.props.children].flat(Infinity).filter(child => typeof child === 'string').join('')).join('\n');
function button(label: string): ReactTestInstance {
  const candidate = root!.root.findAllByType('TouchableOpacity').find(node => node.findAllByType('Text').some(text => [text.props.children].flat(Infinity).join('').includes(label)));
  if (!candidate) throw new Error(`Missing button: ${label}`);
  return candidate;
}
const input = (label: string) => root!.root.findAllByType('TextInput').find(node => node.props.accessibilityLabel === label)!;
const mount = async () => { await act(async () => { root = create(React.createElement(PrivateCard, { userId: 'bob', onOpenThing: mocks.openThing, onOpenPerson: mocks.openPerson })); }); };

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.getPrivatePerson.mockResolvedValue({ userId: 'bob', card: emptyCard, notes: [], links: [] });
  mocks.listPrivateThings.mockResolvedValue({ things: [] });
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe('the private card on a contact profile', () => {
  it('starts collapsed with a summary, opens to the saved notes, and closes again', async () => {
    mocks.getPrivatePerson.mockResolvedValue({ userId: 'bob', card: emptyCard, notes: [{ id: 'n1', text: 'Secret note' }], links: [] });
    await mount();
    expect(texts()).toContain('Private to you');
    expect(texts()).toContain('1 note');
    expect(texts()).not.toContain('Secret note');
    await act(async () => { button('Private to you').props.onPress(); });
    expect(texts()).toContain('Secret note');
    await act(async () => { button('Private to you').props.onPress(); });
    expect(texts()).not.toContain('Secret note');
  });

  it('shows the private name row only inside the opened card', async () => {
    await act(async () => { root = create(React.createElement(PrivateCard, { userId: 'bob', onOpenThing: mocks.openThing, onOpenPerson: mocks.openPerson, nameRow: React.createElement('Text', {}, 'Set private name') })); });
    expect(texts()).not.toContain('Set private name');
    await act(async () => { button('Private to you').props.onPress(); });
    expect(texts()).toContain('Set private name');
  });

  it('saves importance, cadence and a catch-up through the owner’s own card', async () => {
    mocks.updatePrivatePerson
      .mockResolvedValueOnce({ card: { ...emptyCard, important: true } })
      .mockResolvedValueOnce({ card: { ...emptyCard, important: true, cadenceDays: 90, intervalDays: 90, nextDueAt: '2000-01-01T00:00:00Z' } })
      .mockResolvedValueOnce({ card: { ...emptyCard, important: true, cadenceDays: 90, intervalDays: 90, lastContactAt: '2026-10-02T00:00:00Z', nextDueAt: '2099-01-01T00:00:00Z' } });
    await mount();
    await act(async () => { button('Private to you').props.onPress(); });
    await act(async () => { button('Mark important').props.onPress(); });
    expect(mocks.updatePrivatePerson).toHaveBeenLastCalledWith('bob', { important: true });
    expect(texts()).not.toContain('Mark important');
    const important = root!.root.findAllByType('TouchableOpacity').find(node => node.props.accessibilityLabel === 'Important');
    expect(important?.props.accessibilityState).toMatchObject({ selected: true });
    // Cadence choices stay folded behind one chip until asked for.
    expect(texts()).not.toContain('Quarterly');
    await act(async () => { button('Set a catch-up').props.onPress(); });
    await act(async () => { button('Quarterly').props.onPress(); });
    expect(mocks.updatePrivatePerson).toHaveBeenLastCalledWith('bob', { cadenceDays: 90 });
    expect(texts()).toContain('Due now');
    expect(texts()).toContain('Catch up quarterly');
    expect(texts()).toContain('Stretch the gap each time');
    await act(async () => { button('Caught up today').props.onPress(); });
    expect(mocks.updatePrivatePerson).toHaveBeenLastCalledWith('bob', { contactedNow: true });
    expect(texts()).toContain('Next catch-up');
  });

  it('adds a note and a link to a new company, and opens linked things and people', async () => {
    mocks.addPrivateNote.mockResolvedValue({ id: 'n2', text: 'Met at the dinner', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' });
    mocks.addPrivateLink.mockResolvedValue({ id: 'l1', relation: 'works at', direction: 'out', other: { kind: 'company', id: 't1', name: 'Acme Robotics' }, createdAt: '2026-10-02T00:00:00Z' });
    mocks.getPrivatePerson.mockResolvedValue({ userId: 'bob', card: emptyCard, notes: [], links: [{ id: 'l0', relation: 'knows', direction: 'out', other: { kind: 'user', id: 'carol', name: 'Carol' }, createdAt: '2026-10-01T00:00:00Z' }] });
    await mount();
    await act(async () => { button('Private to you').props.onPress(); });
    // The add-link form stays out of the way until "+ Add link".
    expect(input('Name')).toBeUndefined();
    await act(async () => { button('+ Add connection').props.onPress(); });
    // A suggested relation brings its usual kind with it; your own words are still accepted.
    await act(async () => { button('interested in').props.onPress(); });
    expect(input('Name').props.placeholder).toBe('Name of the idea');
    await act(async () => { button('works at').props.onPress(); });
    expect(input('Name').props.placeholder).toBe('Name of the company');
    expect(input('Relation').props.value).toBe('');
    await act(async () => { input('Name').props.onChangeText('Acme Robotics'); });
    await act(async () => { button('Save connection').props.onPress(); });
    expect(input('Name')).toBeUndefined();
    expect(mocks.addPrivateLink).toHaveBeenCalledWith({ kind: 'user', id: 'bob' }, 'works at', { kind: 'company', name: 'Acme Robotics' });
    await act(async () => { button('Acme Robotics').props.onPress(); });
    expect(mocks.openThing).toHaveBeenCalledWith('t1');
    await act(async () => { button('Carol').props.onPress(); });
    expect(mocks.openPerson).toHaveBeenCalledWith('carol');
  });

  it('says so plainly when the private card cannot be loaded or saved', async () => {
    mocks.getPrivatePerson.mockRejectedValue(new Error('offline'));
    await mount();
    expect(texts()).toContain('Private notes unavailable');
  });

  it('keeps the private name row reachable when the private card cannot load', async () => {
    mocks.getPrivatePerson.mockRejectedValue(new Error('offline'));
    await act(async () => { root = create(React.createElement(PrivateCard, { userId: 'bob', onOpenThing: mocks.openThing, onOpenPerson: mocks.openPerson, nameRow: React.createElement('Text', {}, 'Set private name') })); });
    expect(texts()).toContain('Private notes unavailable');
    expect(texts()).toContain('Set private name');
  });
});

describe('private card wording', () => {
  it('describes cadence and due dates in plain words', () => {
    expect(cadenceLabel({ cadenceDays: 7 })).toBe('weekly');
    expect(cadenceLabel({ cadenceDays: 45 })).toBe('every 45 days');
    expect(cadenceLabel({ cadenceDays: null })).toBe('');
    expect(dueLabel(null)).toBe('');
    expect(dueLabel('2000-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:00Z'))).toBe('Due now');
    expect(dueLabel('2099-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:00Z'))).toContain('Next catch-up');
    expect(privateSummary(emptyCard, 0, 0)).toBe('Notes, importance, catch-up and links');
    expect(privateSummary({ ...emptyCard, important: true }, 2, 1)).toBe('Important · 2 notes · 1 link');
  });
});
