import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), manualAsk: vi.fn(), suggest: vi.fn(), list: vi.fn(), apply: vi.fn(), undo: vi.fn(), update: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AccessibilityInfo: { announceForAccessibility: vi.fn() }, StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 }, Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View' }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: 'owner' } }) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: { createPrivateAskReview: mocks.manualAsk, createProfileNoteReview: mocks.create, suggestProfileNoteReview: mocks.suggest, getProfileNoteReviews: mocks.list, applyProfileNoteReview: mocks.apply, undoProfileNoteReview: mocks.undo, updatePrivateAsk: mocks.update } }));
import { ProfileNoteCapture } from '../../mobile/src/components/ProfileNoteCapture.js';
let root: ReturnType<typeof create>;
const subject = { kind: 'user' as const, id: 'profile-capture-test' };
const saved = { id: 'review', subject, note: { id: 'note', text: '  Exact words\n', createdAt: '2026-10-07', updatedAt: '2026-10-07' }, status: 'saved', suggestions: [], appliedIds: [], createdAt: '2026-10-07' };
const button = (text: string) => root.root.findAllByType('TouchableOpacity').find(n => n.findAllByType('Text').some(t => t.props.children === text))!;
beforeEach(() => { vi.clearAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; mocks.list.mockResolvedValue({ reviews: [], asks: [] }); mocks.create.mockResolvedValue(saved); });
afterEach(async () => { await act(async () => root.unmount()); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
it('saves exact original words before extraction, preserving note on suggestion failure', async () => {
  mocks.suggest.mockRejectedValue(new Error('offline'));
  await act(async () => { root = create(React.createElement(ProfileNoteCapture, { subject, onChange: () => {} })); });
  await act(async () => root.root.findByType('TextInput').props.onChangeText(saved.note.text));
  await act(async () => button('Save & review updates').props.onPress());
  expect(mocks.create).toHaveBeenCalledWith(subject, saved.note.text, expect.any(String));
  expect(mocks.create.mock.invocationCallOrder[0]).toBeLessThan(mocks.suggest.mock.invocationCallOrder[0]);
  expect(root.root.findByType('TextInput').props.value).toBe('');
  expect(root.root.findAllByType('Text').some(t => String(t.props.children).includes('Your note is saved. Suggestions failed'))).toBe(true);
});
it('preserves a failed save draft and restores it after changing subjects', async () => {
  mocks.create.mockRejectedValue(new Error('offline'));
  await act(async () => { root = create(React.createElement(ProfileNoteCapture, { subject, onChange: () => {} })); });
  await act(async () => root.root.findByType('TextInput').props.onChangeText('Unsent dictation'));
  await act(async () => button('Save note').props.onPress());
  expect(root.root.findByType('TextInput').props.value).toBe('Unsent dictation');
  await act(async () => root.update(React.createElement(ProfileNoteCapture, { subject: { kind: 'thing', id: 'another' }, onChange: () => {} })));
  expect(root.root.findByType('TextInput').props.value).toBe('');
  await act(async () => root.update(React.createElement(ProfileNoteCapture, { subject, onChange: () => {} })));
  expect(root.root.findByType('TextInput').props.value).toBe('Unsent dictation');
});
it('loads durable undo after remount and leaves the original note', async () => {
  mocks.list.mockResolvedValue({ reviews: [{ ...saved, status: 'applied', appliedIds: ['link'] }], asks: [] }); mocks.undo.mockResolvedValue({ ...saved, status: 'undone' });
  await act(async () => { root = create(React.createElement(ProfileNoteCapture, { subject, onChange: () => {} })); });
  expect(button('Undo imported updates (1)')).toBeDefined();
  await act(async () => button('Undo imported updates (1)').props.onPress());
  expect(mocks.undo).toHaveBeenCalledWith('review');
  expect(root.root.findAllByType('Text').some(t => t.props.children === saved.note.text)).toBe(true);
});

it('ignores a late save response after switching to another subject', async () => {
  let resolve: (value: typeof saved) => void = () => {};
  mocks.create.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => { root = create(React.createElement(ProfileNoteCapture, { subject, onChange: () => {} })); });
  await act(async () => root.root.findByType('TextInput').props.onChangeText('Pending note'));
  await act(async () => button('Save note').props.onPress());
  await act(async () => root.update(React.createElement(ProfileNoteCapture, { subject: { kind: 'thing', id: 'other-late' }, onChange: () => {} })));
  await act(async () => root.root.findByType('TextInput').props.onChangeText('Other subject draft'));
  await act(async () => resolve(saved));
  expect(root.root.findByType('TextInput').props.value).toBe('Other subject draft');
  expect(root.root.findAllByType('Text').some(t => t.props.children === saved.note.text)).toBe(false);
});
it('keeps the same idempotency key when retrying a failed save', async () => {
  mocks.create.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(saved);
  await act(async () => { root = create(React.createElement(ProfileNoteCapture, { subject, onChange: () => {} })); });
  await act(async () => root.root.findByType('TextInput').props.onChangeText('Retry note'));
  await act(async () => button('Save note').props.onPress());
  await act(async () => button('Save note').props.onPress());
  expect(mocks.create.mock.calls[0][2]).toBe(mocks.create.mock.calls[1][2]);
});

it('rejects an A-to-B-to-A late response using the scope generation', async () => {
  let resolve: (value: typeof saved) => void = () => {};
  mocks.create.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => { root = create(React.createElement(ProfileNoteCapture, { subject, onChange: () => {} })); });
  await act(async () => root.root.findByType('TextInput').props.onChangeText('First draft'));
  await act(async () => button('Save note').props.onPress());
  await act(async () => root.update(React.createElement(ProfileNoteCapture, { subject: { kind: 'thing', id: 'aba' }, onChange: () => {} })));
  await act(async () => root.update(React.createElement(ProfileNoteCapture, { subject, onChange: () => {} })));
  await act(async () => root.root.findByType('TextInput').props.onChangeText('New A draft'));
  await act(async () => resolve(saved));
  expect(root.root.findByType('TextInput').props.value).toBe('New A draft');
});

it('adds a private standing ask explicitly without AI and keeps rough-note draft', async () => {
  const manual = { ...saved, id: 'manual', status: 'ready', suggestions: [{ id: 'ask-suggestion', kind: 'ask', text: 'Find a designer', evidence: 'Find a designer' }] };
  mocks.manualAsk.mockResolvedValue(manual); mocks.apply.mockResolvedValue({ ...manual, status: 'applied' });
  await act(async () => { root = create(React.createElement(ProfileNoteCapture, { subject, onChange: () => {} })); });
  await act(async () => root.root.findByType('TextInput').props.onChangeText('Separate rough note'));
  await act(async () => button('+ Add ask').props.onPress());
  const askInput = root.root.findAllByType('TextInput').find(n => n.props.accessibilityLabel === 'New private standing ask')!;
  await act(async () => askInput.props.onChangeText('Find a designer'));
  await act(async () => button('Save privately').props.onPress());
  expect(mocks.manualAsk).toHaveBeenCalledWith(subject, 'Find a designer', expect.any(String));
  expect(mocks.apply).toHaveBeenCalledWith('manual', ['ask-suggestion']);
  expect(mocks.suggest).not.toHaveBeenCalled();
  expect(root.root.findByType('TextInput').props.value).toBe('Separate rough note');
});

it('keeps a manual ask as a ready review when applying fails, without invoking AI', async () => {
  const manual = { ...saved, id: 'manual-failed', status: 'ready', suggestions: [{ id: 'manual-s', kind: 'ask', text: 'Find a venue', evidence: 'Find a venue' }] };
  mocks.manualAsk.mockResolvedValue(manual); mocks.apply.mockRejectedValue(new Error('offline'));
  await act(async () => { root = create(React.createElement(ProfileNoteCapture, { subject, onChange: () => {} })); });
  await act(async () => button('+ Add ask').props.onPress());
  await act(async () => root.root.findAllByType('TextInput').find(n => n.props.accessibilityLabel === 'New private standing ask')!.props.onChangeText('Find a venue'));
  await act(async () => button('Save privately').props.onPress());
  expect(button('Apply selected (1)')).toBeDefined();
  expect(root.root.findAllByType('Text').some(t => String(t.props.children).includes('Your ask text is saved.'))).toBe(true);
  expect(mocks.suggest).not.toHaveBeenCalled();
});

it('keeps the source note for an already-recorded manual ask without an empty apply', async () => {
  const manual = { ...saved, id: 'manual-duplicate', status: 'ready', suggestions: [{ id: 'duplicate-s', kind: 'ask', text: 'Find a venue', evidence: 'Find a venue', duplicate: true }] };
  mocks.manualAsk.mockResolvedValue(manual);
  await act(async () => { root = create(React.createElement(ProfileNoteCapture, { subject, onChange: () => {} })); });
  await act(async () => button('+ Add ask').props.onPress());
  await act(async () => root.root.findAllByType('TextInput').find(n => n.props.accessibilityLabel === 'New private standing ask')!.props.onChangeText('Find a venue'));
  await act(async () => button('Save privately').props.onPress());
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(mocks.suggest).not.toHaveBeenCalled();
  expect(root.root.findAllByType('Text').some(t => String(t.props.children).includes('Already recorded. Your source note is saved'))).toBe(true);
  expect(button('+ Add ask')).toBeDefined();
});
