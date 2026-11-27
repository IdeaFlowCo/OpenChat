import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  chat: {} as Record<string, any>, route: { params: { connectionId: 'connection-a', chatKey: 'chat-a', kind: 'open' } as any },
  navigation: { navigate: vi.fn() }, text: [] as string[], authorize: vi.fn(), acceptGrant: vi.fn(), enableRegistry: vi.fn(), alert: vi.fn(), clearRegistry: vi.fn(),
  api: { listBeeperConnections: vi.fn(), approveBeeperConnection: vi.fn(), revokeBeeperConnection: vi.fn(), getBeeperCatalogue: vi.fn(), requestBeeperRead: vi.fn(), attachBeeperReadIntent: vi.fn(), getBeeperReadJob: vi.fn() },
}));
vi.mock('react-native', async () => {
  const React = await import('react');
  return { Alert: {alert:m.alert}, Platform:{OS:'ios'}, StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }, View: 'View', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity',
    Text: ({ children, ...props }: any) => { m.text.push(String(children)); return React.createElement('Text', props, children); } };
});
vi.mock('@react-navigation/native', () => ({ useNavigation: () => m.navigation, useRoute: () => m.route, useFocusEffect: (cb: any) => React.useEffect(cb, [cb]) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'synthetic-request-uuid' }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => m.chat }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: m.api }));
vi.mock('../../mobile/src/services/beeper/deviceRegistry', () => ({acceptBeeperReadOffer:m.acceptGrant,enableBeeperReadRegistry:m.enableRegistry}));
vi.mock('../../mobile/src/services/beeper/readIntent', () => ({ authorizeBeeperRead: m.authorize }));
vi.mock('../../mobile/src/components/ui', () => ({ Button: 'Button', Card: 'Card', Chip: 'Chip', ListRow: 'ListRow', SectionLabel: 'SectionLabel' }));
vi.mock('../../mobile/src/components/ImportedChatParts', () => ({ useImportedRoles: () => ({ text: 'text', textMeta: 'metadata', line: 'border', danger: 'danger' }) }));

import { BeeperChatsScreen, BeeperReadScreen } from '../../mobile/src/screens/BeeperChatsScreen';
import { BeeperSourceStatus } from '../../mobile/src/components/BeeperSourceStatus';
import { beeperConnectionState, beeperJobState, parsePublicBeeperOffer } from '../../mobile/src/utils/beeperStatus';

const connection = { id: 'connection-a', accountKey: 'account-a', machineKey: 'machine-a', deviceKey: 'device-a', state: 'active', expiresAt: '2030-01-01T00:00:00Z', heartbeatAt: '2026-11-26T00:00:00Z' };
const entry = { chatKey: 'chat-a', title: 'Synthetic private chat', chatType: 'group', sourceReadAt: '2026-11-26T00:00:00Z', importedChatId: 'saved-a' };
const job = { id: 'job-a', epoch: 1, nextSequence: 0, kind: 'open', state: 'pending' };
let tree: ReactTestRenderer | undefined;
const buttons = (label: string) => tree!.root.findAllByType('Button' as any).filter(node => node.props.label === label);
async function press(label: string) { await act(async () => { buttons(label)[0].props.onPress(); }); }
async function render(element: React.ReactElement) { await act(async () => { tree = create(element); }); await act(async () => { await vi.advanceTimersByTimeAsync(1); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  m.enableRegistry.mockReturnValue(m.clearRegistry);
  m.chat = { currentUser: { userId: 'owner-a' }, isIdentityVerified: true }; m.text.length = 0;
  m.route.params = { connectionId: 'connection-a', chatKey: 'chat-a', kind: 'open' };
  m.api.listBeeperConnections.mockResolvedValue([connection]);
  m.api.getBeeperCatalogue.mockResolvedValue({ connection, items: [entry], nextCursor: null });
  m.api.requestBeeperRead.mockResolvedValue(job); m.api.getBeeperReadJob.mockResolvedValue(job);
  m.api.attachBeeperReadIntent.mockResolvedValue({ ok: true }); m.authorize.mockResolvedValue('synthetic-opaque-frame');
});
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; vi.useRealTimers(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

describe('Beeper client explicit source reads', () => {
  it('waits for verified identity before reading any private catalogue or job', async () => {
    m.chat.isIdentityVerified = false; await render(React.createElement(BeeperReadScreen));
    expect(m.api.listBeeperConnections).not.toHaveBeenCalled(); expect(m.api.requestBeeperRead).not.toHaveBeenCalled();
  });
  it('reserves only the selected chat and requires a separate typed authorization before attaching an intent', async () => {
    await render(React.createElement(BeeperReadScreen));
    expect(m.api.getBeeperCatalogue).toHaveBeenCalledWith('connection-a', { chatKey: 'chat-a' });
    expect(m.api.requestBeeperRead).toHaveBeenCalledWith('connection-a', { chatKey: 'chat-a', kind: 'open', clientRequestId: 'beeper-read:synthetic-request-uuid' });
    expect(m.authorize).not.toHaveBeenCalled(); expect(m.api.attachBeeperReadIntent).not.toHaveBeenCalled();
    await press('Authorize selected chat read');
    expect(m.authorize).toHaveBeenCalledWith(connection, job, entry,'owner-a');
    expect(m.api.attachBeeperReadIntent).toHaveBeenCalledWith('connection-a', 'job-a', 'synthetic-opaque-frame');
    expect(m.text.join(' ')).toContain('Waiting for Mac');
  });
  it('preserves the pending job and shows the genuine secure-grant boundary without attaching a frame', async () => {
    m.authorize.mockRejectedValue(Object.assign(new Error('private helper details'), { code: 'beeper_secure_grant_required' }));
    await render(React.createElement(BeeperReadScreen)); await press('Authorize selected chat read');
    expect(m.text.join(' ')).toContain('Secure device pairing must be enabled');
    expect(m.api.attachBeeperReadIntent).not.toHaveBeenCalled();
    expect(m.api.requestBeeperRead).toHaveBeenCalledTimes(1);
    expect(buttons('Authorize selected chat read')).toHaveLength(1);
  });
  it('does not label partial batches or a saved copy as a completed source refresh', async () => {
    m.api.getBeeperReadJob.mockResolvedValue({ ...job, state: 'leased', nextSequence: 1, lastBatchAt: '2026-11-26T01:00:00Z', chatId: 'saved-a' });
    await render(React.createElement(BeeperReadScreen));
    expect(m.text.join(' ')).toContain('Partial copy received');
    expect(m.text.join(' ')).not.toContain('Server-confirmed completion');
    await press('Open saved copy');
    expect(m.navigation.navigate).toHaveBeenCalledWith('ImportedChat', expect.objectContaining({ chatId: 'saved-a', beeper: { connectionId: 'connection-a', chatKey: 'chat-a', jobId: 'job-a' } }));
  });
  it('uses only a completed server receipt to show the source completion timestamp', async () => {
    m.api.getBeeperReadJob.mockResolvedValue({ ...job, state: 'done', completedAt: '2026-11-26T02:00:00Z', chatId: 'saved-a' });
    await render(React.createElement(BeeperReadScreen));
    expect(m.text.join(' ')).toContain('Server-confirmed completion');
    expect(m.text.join(' ')).toContain('Coverage can still be partial');
    expect(m.api.attachBeeperReadIntent).not.toHaveBeenCalled();
  });
  it('discards old owner/target content on the first render and ignores an old authorization result', async () => {
    let resolve!: (frame: string) => void; m.authorize.mockImplementation(() => new Promise(r => { resolve = r; }));
    await render(React.createElement(BeeperReadScreen)); await press('Authorize selected chat read');
    m.text.length = 0; m.chat.currentUser = { userId: 'owner-b' }; m.api.listBeeperConnections.mockImplementation(() => new Promise(() => {}));
    await act(async () => tree!.update(React.createElement(BeeperReadScreen)));
    expect(m.text.join(' ')).not.toContain('Synthetic private chat');
    await act(async () => resolve('old-frame'));
    expect(m.api.attachBeeperReadIntent).not.toHaveBeenCalled();
    m.text.length = 0; m.route.params.chatKey = 'chat-b';
    await act(async () => tree!.update(React.createElement(BeeperReadScreen)));
    expect(m.text.join(' ')).not.toContain('Synthetic private chat');
  });
  it('refreshes from the saved reader by requesting a new source job visit', async () => {
    m.api.getBeeperReadJob.mockResolvedValue({ ...job, state: 'done', completedAt: '2026-11-26T02:00:00Z' });
    await render(React.createElement(BeeperSourceStatus, { source: { connectionId: 'connection-a', chatKey: 'chat-a', jobId: 'job-a' } }));
    await press('Refresh from Beeper');
    expect(m.navigation.navigate).toHaveBeenCalledWith('BeeperRead', { connectionId: 'connection-a', chatKey: 'chat-a', kind: 'refresh', requestRevision: 'synthetic-request-uuid' });
  });
  it('uses bounded server pagination and server search instead of filtering only the loaded first page', async () => {
    m.api.getBeeperCatalogue.mockResolvedValueOnce({ connection, items: [entry], nextCursor: 'next-page' });
    await render(React.createElement(BeeperChatsScreen));
    await press('Load more source chats');
    expect(m.api.getBeeperCatalogue).toHaveBeenLastCalledWith('connection-a', { search: '', cursor: 'next-page' });
    const search = tree!.root.findByProps({ accessibilityLabel: 'Search Beeper chats' });
    await act(async () => search.props.onChangeText('beyond first page'));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(m.api.getBeeperCatalogue).toHaveBeenLastCalledWith('connection-a', { search: 'beyond first page', cursor: undefined });
  });
  it('never approves an offer merely because setup was opened or JSON was pasted', async () => {
    await render(React.createElement(BeeperChatsScreen)); await press('Set up Mac connection');
    const field = tree!.root.findByProps({ accessibilityLabel: 'Public Mac offer' });
    await act(async () => field.props.onChangeText(JSON.stringify({ destination: 'https://other.invalid', token: 'do-not-send' })));
    await press('Review Mac offer');
    expect(m.api.approveBeeperConnection).not.toHaveBeenCalled();
    expect(m.text.join(' ')).toContain('No connection was approved');
  });
  it('imports no selected grant until a separate explicit native confirmation, then clears its resolver on account change', async () => {
    m.acceptGrant.mockImplementation(async (_owner, _wire, confirm) => { if (!await confirm({title:'Locally approved chat',chatType:'group',expiresAt:Date.now()+3600000})) throw new Error('cancelled'); });
    await render(React.createElement(BeeperChatsScreen)); await press('Set up Mac connection');
    await act(async () => tree!.root.findByProps({accessibilityLabel:'Encrypted selected chat grant'}).props.onChangeText('encrypted-wire'));
    expect(m.acceptGrant).not.toHaveBeenCalled(); expect(m.enableRegistry).not.toHaveBeenCalled();
    await press('Review selected chat grant'); expect(m.alert).toHaveBeenCalledTimes(1); expect(m.enableRegistry).not.toHaveBeenCalled();
    await act(async()=>m.alert.mock.calls[0][2][1].onPress());
    expect(m.acceptGrant).toHaveBeenCalledWith('owner-a','encrypted-wire',expect.any(Function));
    expect(m.enableRegistry).toHaveBeenCalledWith('owner-a');
    m.chat.currentUser={userId:'owner-b'}; await act(async()=>tree!.update(React.createElement(BeeperChatsScreen)));
    expect(m.clearRegistry).toHaveBeenCalledTimes(1);
  });
  it('does not enable a native signer after its confirmation crosses an account boundary', async () => {
    m.acceptGrant.mockImplementation(async (_owner,_wire,confirm)=>{if(!await confirm({title:'Private chat',chatType:'direct',expiresAt:Date.now()+3600000}))throw new Error('cancelled');});
    await render(React.createElement(BeeperChatsScreen));await press('Set up Mac connection');
    await act(async()=>tree!.root.findByProps({accessibilityLabel:'Encrypted selected chat grant'}).props.onChangeText('encrypted-wire'));
    await press('Review selected chat grant');m.chat.isIdentityVerified=false;
    await act(async()=>tree!.update(React.createElement(BeeperChatsScreen)));
    await act(async()=>m.alert.mock.calls[0][2][1].onPress());
    expect(m.enableRegistry).not.toHaveBeenCalled();
  });
  it('requires review and a separate explicit approval for a valid public Mac offer', async () => {
    const offer = { protocol: 'openchat.beeper.read.v1', destination: 'https://chat.ideaflow.app', connectionId: 'a'.repeat(48), machineKey: 'b'.repeat(64), deviceKey: 'c'.repeat(64), accountKey: 'd'.repeat(64), catalogueGrantId: 'e'.repeat(48), relayTokenHash: 'f'.repeat(64), relayBinding:'0'.repeat(64),ownerUserId:'owner-a', expiresAt: new Date(Date.now() + 3600000).toISOString() };
    await render(React.createElement(BeeperChatsScreen)); await press('Set up Mac connection');
    await act(async () => tree!.root.findByProps({ accessibilityLabel: 'Public Mac offer' }).props.onChangeText(JSON.stringify(offer)));
    await press('Review Mac offer');
    expect(m.api.approveBeeperConnection).not.toHaveBeenCalled();
    await press('Approve read-only connection');
    expect(m.api.approveBeeperConnection).toHaveBeenCalledExactlyOnceWith(offer);
  });
  it('keeps expired connections out of source refresh and never claims unknown heartbeat is connected', async () => {
    m.api.listBeeperConnections.mockResolvedValue([{ ...connection, expiresAt: '2020-01-01T00:00:00Z' }]);
    await render(React.createElement(BeeperSourceStatus, { source: { connectionId: 'connection-a', chatKey: 'chat-a' } }));
    expect(buttons('Refresh from Beeper')[0].props.disabled).toBe(true);
    expect(beeperConnectionState({ ...connection, heartbeatAt: 'invalid' })).toBe('Waiting for Mac');
    expect(beeperJobState({ ...job, state: 'done' } as any, true)).toBe('Completion not yet confirmed');
  });
  it('rejects extra offer fields that could contain private keys or tokens', () => {
    const publicOffer = { protocol: 'openchat.beeper.read.v1', destination: 'https://chat.ideaflow.app', connectionId: 'a'.repeat(48), machineKey: 'b'.repeat(64), deviceKey: 'c'.repeat(64), accountKey: 'd'.repeat(64), catalogueGrantId: 'e'.repeat(48), relayTokenHash: 'f'.repeat(64), relayBinding:'0'.repeat(64),ownerUserId:'owner-a', expiresAt: new Date(Date.now() + 3600000).toISOString() };
    expect(() => parsePublicBeeperOffer(JSON.stringify({ ...publicOffer, privateKey: 'never-send' }))).toThrow();
    expect(parsePublicBeeperOffer(JSON.stringify(publicOffer)).destination).toBe('https://chat.ideaflow.app');
    const imessage={...publicOffer,protocol:'openchat.beeper.imessage.read.v1',network:'imessage'};
    expect(parsePublicBeeperOffer(JSON.stringify(imessage))).toEqual(imessage);
    expect(()=>parsePublicBeeperOffer(JSON.stringify({...publicOffer,network:'imessage'}))).toThrow();
    expect(()=>parsePublicBeeperOffer(JSON.stringify({...publicOffer,protocol:'openchat.beeper.imessage.read.v1'}))).toThrow();
  });
});

it('does not offer authorization when reservation and selected read kinds differ',async()=>{
 m.api.requestBeeperRead.mockResolvedValue({...job,kind:'refresh'});
 await render(React.createElement(BeeperReadScreen));expect(m.api.getBeeperReadJob).not.toHaveBeenCalled();expect(buttons('Authorize selected chat read')).toHaveLength(0);expect(m.authorize).not.toHaveBeenCalled();expect(m.text.join(' ')).toContain('different read is already pending');
});
it.each([{...job,id:'substituted-job'},{...job,kind:'earlier'}])('rejects a refetched job that differs from the reserved read before approval',async changed=>{
 m.api.getBeeperReadJob.mockResolvedValue(changed);await render(React.createElement(BeeperReadScreen));expect(buttons('Authorize selected chat read')).toHaveLength(0);expect(m.api.attachBeeperReadIntent).not.toHaveBeenCalled();expect(m.authorize).not.toHaveBeenCalled();expect(m.text.join(' ')).toContain('different read is already pending');
});

it('names iMessage on the selected-read screen before requesting native authorization',async()=>{
 const im={...connection,protocol:'openchat.beeper.imessage.read.v1',network:'imessage'};
 m.api.listBeeperConnections.mockResolvedValue([im]);m.api.getBeeperCatalogue.mockResolvedValue({connection:im,items:[{...entry,network:'imessage'}],nextCursor:null});m.api.requestBeeperRead.mockResolvedValue({...job,network:'imessage'});m.api.getBeeperReadJob.mockResolvedValue({...job,network:'imessage'});
 await render(React.createElement(BeeperReadScreen));expect(m.text.join(' ')).toContain('iMessage · Only this selected chat');expect(m.authorize).not.toHaveBeenCalled();
});
it('distinguishes a confirmed empty Mac report from waiting for the first report without reading messages',async()=>{
 m.api.getBeeperCatalogue.mockResolvedValue({connection:{...connection,catalogueReportedAt:'2026-11-27T00:00:00Z',catalogueEmpty:true},items:[],nextCursor:null});
 await render(React.createElement(BeeperChatsScreen));
 expect(m.text.join(' ')).toContain('Your Mac reported no supported chats');expect(m.api.requestBeeperRead).not.toHaveBeenCalled();
});
