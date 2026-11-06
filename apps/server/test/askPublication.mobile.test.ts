import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({ owner:'owner', focused:true, getAskPublication:vi.fn(), publishAsk:vi.fn(), revokeAskPublication:vi.fn(), getContacts:vi.fn(), listPublishedAsks:vi.fn() }));
vi.mock('react-native',()=>({Platform:{OS:'ios',select:(value:any)=>value.ios??value.default},StyleSheet:{create:(value:unknown)=>value,hairlineWidth:1},Text:'Text',TextInput:'TextInput',TouchableOpacity:'TouchableOpacity',View:'View',ActivityIndicator:'ActivityIndicator'}));
vi.mock('@react-navigation/native',()=>({useFocusEffect:(fn:any)=>React.useEffect(()=>mocks.focused?fn():undefined,[fn,mocks.focused])}));
vi.mock('expo-crypto',()=>({randomUUID:()=> 'review-request-1'}));
vi.mock('../../mobile/src/api/client',()=>({api:mocks}));
vi.mock('../../mobile/src/contexts/ThemeContext',()=>({useTheme:()=>({scheme:'light'})}));
vi.mock('../../mobile/src/contexts/ChatContext',()=>({useChat:()=>({currentUser:{userId:mocks.owner}})}));
import { AskPublicationControls } from '../../mobile/src/components/AskPublicationControls.js';
import { PublishedAsks } from '../../mobile/src/components/PublishedAsks.js';
let root:ReturnType<typeof create>;
const ask:any={id:'ask-1',revision:4,text:'Private source text',fromMe:true};
const publication:any={id:'publication-1',revision:0,sourceRevision:4,text:'Approved public excerpt',audienceKind:'public',state:'active',lifecycle:'open'};
const texts=()=>root.root.findAllByType('Text').map(node=>[node.props.children].flat(Infinity).filter(value=>typeof value==='string').join('')).join('\n');
const button=(label:string)=>root.root.findAllByType('TouchableOpacity').find(node=>node.findAllByType('Text').some(text=>text.props.children===label))!;
const press=async(label:string)=>{const node=button(label);expect(node).toBeDefined();expect(node.props.disabled).not.toBe(true);await act(async()=>node.props.onPress());};
beforeEach(()=>{vi.clearAllMocks();mocks.owner='owner';mocks.focused=true;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;mocks.getAskPublication.mockResolvedValue({publication:null,recipients:[],publishedVersionDiffers:false});mocks.getContacts.mockResolvedValue([{id:'vlad',name:'Synthetic Vlad'}]);mocks.publishAsk.mockImplementation(async(_id,input)=>input.confirm?{publication}:{approvalRequired:true,approvalGrant:'payload-bound-grant',preview:{text:input.text,audience:input.audience.kind,recipients:input.audience.kind==='people'?[{userId:'vlad',displayName:'Synthetic Vlad'}]:[]}});mocks.revokeAskPublication.mockResolvedValue({publication:{...publication,state:'revoked',revision:1}});mocks.listPublishedAsks.mockResolvedValue({publications:[],nextCursor:null});});
afterEach(async()=>{await act(async()=>root?.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
describe('native publication review and viewer snapshots',()=>{
  it('shows unknown access honestly during unavailable reads and prevents publishing',async()=>{
    mocks.getAskPublication.mockRejectedValue(new Error('Publication service unavailable'));
    await act(async()=>{root=create(React.createElement(AskPublicationControls,{ask}));});
    expect(texts()).toContain('Visibility unavailable');expect(texts()).not.toContain('Only you');expect(button('Prepare publication')).toBeUndefined();expect(mocks.publishAsk).not.toHaveBeenCalled();
  });
  it('reviews exact text before publishing and repeats the same payload with its grant',async()=>{
    await act(async()=>{root=create(React.createElement(AskPublicationControls,{ask}));});
    await press('Prepare publication');await act(async()=>root.root.findByType('TextInput').props.onChangeText('Approved public excerpt'));await press('Review publication');
    expect(mocks.publishAsk).toHaveBeenCalledTimes(1);expect(mocks.publishAsk.mock.calls[0][1]).toMatchObject({confirm:false,expectedAskRevision:4,expectedPublicationRevision:null,text:'Approved public excerpt',audience:{kind:'public',targets:[]}});
    expect(texts()).toContain('Everyone, including people signed out');expect(texts()).toContain('No messages, notifications or quiet matching');
    await press('Publish');expect(mocks.publishAsk).toHaveBeenLastCalledWith('ask-1',{...mocks.publishAsk.mock.calls[0][1],confirm:true,approvalGrant:'payload-bound-grant'});
    expect(texts()).toContain('Public · until you revoke it');await press('Revoke publication');expect(mocks.revokeAskPublication).toHaveBeenCalledWith('ask-1',0);expect(texts()).toContain('Revoked · private ask retained');
  });
  it('selects verified recipient rows and preserves named audience in review',async()=>{
    await act(async()=>{root=create(React.createElement(AskPublicationControls,{ask}));});await press('Prepare publication');await press('Selected people');
    expect(button('Review publication').props.disabled).toBe(true);await press('Find people');await press('Select Synthetic Vlad');await press('Review publication');
    expect(mocks.publishAsk).toHaveBeenCalledWith('ask-1',expect.objectContaining({audience:{kind:'people',targets:[{kind:'openchat_user',id:'vlad'}]}}));expect(texts()).toContain('Synthetic Vlad');expect(mocks.publishAsk.mock.calls[0][1]).not.toHaveProperty('carrier');
  });
  it('ignores a deferred old page after blur and a fresh focus read observes revocation',async()=>{
    const initial={...publication,publisher:{userId:'publisher',displayName:'Publisher'},audience:'shared_with_you',publishedAt:'2026-11-04',updatedAt:'2026-11-04'};
    let resolveOld!:(value:unknown)=>void;
    mocks.listPublishedAsks.mockResolvedValueOnce({publications:[initial],nextCursor:'old-cursor'}).mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockResolvedValueOnce({publications:[],nextCursor:null});
    await act(async()=>{root=create(React.createElement(PublishedAsks));});await press('Load more');
    mocks.focused=false;await act(async()=>root.update(React.createElement(PublishedAsks)));
    mocks.focused=true;await act(async()=>root.update(React.createElement(PublishedAsks)));
    expect(texts()).toContain('No asks are currently shared directly with you');
    await act(async()=>resolveOld({publications:[{...initial,id:'revoked-row',text:'Stale revoked targeted excerpt'}],nextCursor:'stale-next'}));
    expect(texts()).not.toContain('Stale revoked targeted excerpt');expect(button('Load more')).toBeUndefined();
    expect(texts()).toContain('No asks are currently shared directly with you');
  });
  it('clears targeted snapshots on account switch and keeps read failure distinct from an empty list',async()=>{
    const item={...publication,publisher:{userId:'publisher',displayName:'Publisher'},audience:'shared_with_you',publishedAt:'2026-11-04',updatedAt:'2026-11-04'};
    mocks.listPublishedAsks.mockResolvedValue({publications:[item],nextCursor:null});await act(async()=>{root=create(React.createElement(PublishedAsks));});expect(texts()).toContain('Approved public excerpt');
    mocks.owner='another-owner';mocks.listPublishedAsks.mockReturnValue(new Promise(()=>{}));await act(async()=>root.update(React.createElement(PublishedAsks)));expect(texts()).not.toContain('Approved public excerpt');
    mocks.owner='third-owner';mocks.listPublishedAsks.mockRejectedValue(new Error('Published asks unavailable'));await act(async()=>root.update(React.createElement(PublishedAsks)));expect(texts()).toContain('Published asks unavailable');expect(texts()).not.toContain('No asks are currently shared');
  });
});
