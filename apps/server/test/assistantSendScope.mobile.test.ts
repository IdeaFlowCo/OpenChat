import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const disk = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => disk.get(key) ?? null,
  setItem: async (key: string, value: string) => { disk.set(key, value); },
  removeItem: async (key: string) => { disk.delete(key); },
  getAllKeys: async () => [...disk.keys()],
} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
let nextId=0;
vi.mock('expo-crypto', () => ({ randomUUID: () => 'offline-id-'+(++nextId) }));
vi.mock('../../mobile/src/services/clientLogger', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }));
vi.mock('react-native', () => ({ Alert: {alert: vi.fn()}, Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default } }));
vi.mock('expo-image-picker', () => ({ UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' } }));
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///docs/', cacheDirectory: 'file:///cache/', FileSystemUploadType: { BINARY_CONTENT: 0 },
  copyAsync: vi.fn(), deleteAsync: vi.fn(), makeDirectoryAsync: vi.fn(), getInfoAsync: vi.fn(), uploadAsync: vi.fn(), downloadAsync: vi.fn() }));
vi.mock('../../mobile/src/services/notifications', () => ({ setUnreadBadgeCount: vi.fn(), setActiveConversationForNotifications: vi.fn(), loadMutedConvs: async () => ({}) }));
vi.mock('../../mobile/src/services/haptics', () => ({ hapticTickle: vi.fn(), hapticSend: vi.fn() }));
vi.mock('../../mobile/src/components/InAppMessageBanner', () => ({ showInAppBanner: vi.fn() }));
vi.mock('../../mobile/src/api/socket', () => ({ connect: async () => ({ connected: true, on() {}, off() {} }), disconnect: vi.fn(), joinConversation: vi.fn(), leaveConversation: vi.fn(), emitPresenceUpdate: vi.fn(), sendMessage: vi.fn() }));

import { clearSession, setSession } from '../../mobile/src/api/client';
import { ChatProvider, useChat } from '../../mobile/src/contexts/ChatContext';
import { RecordingProvider, useRecording } from '../../mobile/src/contexts/RecordingContext';
const audio=vi.hoisted(()=>({start:vi.fn(),upload:vi.fn()}));
vi.mock('../../mobile/src/services/audioRecorder',()=>({startRecording:audio.start,stopRecording:async()=>({uri:'synthetic-audio',durationMs:1000}),cancelRecording:vi.fn(),MicrophoneJustEnabledError:class extends Error {}}));
vi.mock('../../mobile/src/services/attachments',()=>({uploadAudio:audio.upload,isPermanentUploadError:()=>false}));

let chat: ReturnType<typeof useChat>;
let root: ReturnType<typeof create>;
let identity: (value: Response) => void;
const fetchMock = vi.fn();
const conversation = { id: 'shared', type: 'direct', title: 'Saved conversation', participants: [] };
const json = (value: unknown) => new Response(JSON.stringify(value));
let recording: ReturnType<typeof useRecording>;
function RecordingProbe(){recording=useRecording();return null;}
function Probe() {
  chat = useChat();
  return React.createElement(RecordingProvider,{isAuthed:chat.isAuthed,conversationsLoaded:chat.conversationsLoaded,conversationExists:()=>true,sendMessage:chat.sendMessageToConversation,captureSendExtras:chat.captureSendExtras,children:React.createElement(RecordingProbe)});
}

beforeEach(async () => {
  vi.useFakeTimers();
  nextId=0;audio.start.mockReset().mockResolvedValue({});audio.upload.mockReset().mockResolvedValue({type:'audio',url:'synthetic-audio',mimeType:'audio/mp4',durationMs:1000});
  disk.clear();
  await clearSession();
  await setSession('token-B', { userId: 'alice', email: 'alice@example.invalid' });
  disk.set('openchat:offline:v1:alice:cache', JSON.stringify({ conversations: [conversation], threads: { shared: [] } }));
  const pending = new Promise<Response>(resolve => { identity = resolve; });
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/auth/me' && !init?.method) return pending;
    if (path === '/api/chat/conversations') return json([conversation]);
    if (path.endsWith('/messages')) return json({ messages: [], hasMore: false });
    if (path.endsWith('/read')) return json({ readMap: { peer: '2026-10-19T01:00:00Z' }, onlineMap: { peer: true } });
    if (path.includes('matches')) return json({ matches: [] });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => { root = create(React.createElement(ChatProvider, null, React.createElement(Probe))); });
});

afterEach(async () => {
  await act(async () => root.unmount());
  await clearSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

it('persists selected scope through the real shared outbox for files, captions, text and emoji',async()=>{
  await act(async()=>{void chat.bootstrapIfAuthed();});
  await act(async()=>{chat.setActiveConversation('shared');chat.setAssistantScope('shared','conversation');});
  const file={type:'file' as const,url:'synthetic-file',mimeType:'text/plain',filename:'synthetic.txt'};
  for(const caption of ['', 'file caption']){
    await act(async()=>{await chat.sendMessage(caption,'reply',[file]);});
    expect(chat.messages.at(-1)).toMatchObject({content:caption,assistantScope:'conversation',replyToId:'reply',attachments:[file]});
  }
  await act(async()=>{await chat.sendMessage('text');});
  expect(chat.messages.at(-1)).toMatchObject({content:'text',assistantScope:'conversation'});
  await act(async()=>{await chat.sendMessage('🙂','reply',undefined,undefined,{emojiSize:3});});
  expect(chat.messages.at(-1)).toMatchObject({content:'🙂',assistantScope:'conversation',emojiSize:3});
  expect(fetchMock.mock.calls.map(([url])=>new URL(url).pathname)).toEqual(['/api/auth/me']);
});

it.each([['conversation','universal'],['universal','conversation']] as const)('retains %s recording-start scope after changing preference to %s',async(initial,next)=>{
  await act(async()=>{void chat.bootstrapIfAuthed();});
  await act(async()=>{chat.setActiveConversation('shared');chat.setAssistantScope('shared',initial);});
  let ready!:(value:object)=>void;
  audio.start.mockImplementationOnce(()=>new Promise(resolve=>{ready=resolve;}));
  let starting!:Promise<void>;
  await act(async()=>{starting=recording.start('shared','Assistant','reply');});
  await act(async()=>{chat.setAssistantScope('shared',next);chat.setActiveConversation('other');ready({});await starting;});
  let sent=false;
  await act(async()=>{sent=await recording.stopAndSend();});
  expect(sent).toBe(true);
  await act(async()=>{chat.setActiveConversation('shared');});
  expect(chat.messages.at(-1)).toMatchObject({assistantScope:initial,conversationId:'shared',replyToId:'reply',attachments:[{type:'audio'}]});
  expect(chat.captureSendExtras('shared').assistantScope).toBe(next);
});
