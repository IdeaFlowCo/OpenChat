// Synthetic offline UI fixture using the real provider, storage and ChatScreen.
// Build from repo root: node apps/server/test/offlineChat.browser.mjs .offline-evidence
// Serve the output locally. No production messages or credentials are used.
// offlineFixture(true): disconnect; compose and click Send; check Waiting to send.
// Reload: cached history and pending bubble remain. offlineFixture(false): one
// canonical message replaces the pending bubble. Check at phone/desktop widths.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const out = path.resolve(process.argv[2] || '.offline-evidence');
await mkdir(out, { recursive: true });
const mocks = new Map();
const mock = (suffix, code) => mocks.set(suffix, code);
mock('/api/client', `
export const OPENCHAT_URL='http://fixture.invalid';
const conversation={id:'sailing',type:'group',title:'Sailing Buddies',participants:[{user:{id:'me',name:'You'}},{user:{id:'alice',name:'Alice'}}]};
export const history={id:'history',conversationId:'sailing',senderId:'alice',sender:{id:'alice',name:'Alice'},content:'History recovered after Retry.',createdAt:'2026-10-07T06:00:00Z'};
let fail=false, pending;
window.fixture={holdHistory(){pending={};pending.promise=new Promise(r=>pending.resolve=r);},releaseHistory(){pending.resolve({messages:[history],hasMore:false});pending=null;}};
export const api={getConversationContent:async()=>({items:[],hasMore:false}),getMe:async()=>({id:'me',name:'You'}),getConversations:async()=>[conversation],listMatches:async()=>[],getAiDisclosureStatus:async()=>({acceptedAt:'2026-01-01'}),messagesSince:async()=>({messages:[],truncated:true}),markRead:async()=>({readMap:{},onlineMap:{}}),getMessages:async()=>{if(fail){fail=false;throw Error('Synthetic offline response');}return pending?pending.promise:{messages:[history],hasMore:false};},listContextPosts:async()=>({posts:[{id:'context-1',conversationId:'sailing',authorId:'alice',author:{id:'alice',name:'Alice'},text:'Context content reached the screen.',kind:'note',revision:1,createdAt:'2026-10-07T06:00:00Z'}]}),getMentionCandidates:async()=>[],getUnreadCounts:async()=>({})};
export const getSessionIdentity=()=>api.getMe();
export const getToken=async()=>'synthetic',getUser=async()=>({userId:'me',name:'You'}),setSession=async()=>{},clearSession=async()=>{},onAuthExpired=()=>()=>{},isDroppedMessageSend=()=>false;
`);
mock('/api/socket', `const handlers=new Map();const socket={connected:localStorage.fixtureOffline!=='true',on:(e,f)=>handlers.set(e,f),off:e=>handlers.delete(e)};window.emitFixture=(e,p)=>handlers.get(e)?.(p);window.offlineFixture=(offline)=>{localStorage.fixtureOffline=String(offline);socket.connected=!offline;handlers.get(offline?'disconnect':'connect')?.();};export const connect=async()=>socket,getSocket=()=>socket,disconnect=()=>{},joinConversation=()=>{},leaveConversation=()=>{},emitPresenceUpdate=()=>{},emitTypingStart=()=>{},emitTypingStop=()=>{};export const sendMessage=async(conversationId,content,replyToId,id)=>({id,conversationId,content,replyToId,senderId:'me',createdAt:new Date().toISOString()});`);
mock('/contexts/ThemeContext', `export const useTheme=()=>({scheme:'light'});`);
mock('/contexts/SocialExperienceContext', `export const useSocialExperience=()=>({enhanced:false});`);
mock('/contexts/RecordingContext', `export const useRecording=()=>({status:'idle',conversationId:null,elapsedMs:0,pressStartX:{current:0}});`);
mock('/contexts/PrivateNamesContext', `export const usePrivateName=()=>({name:null});`);
mock('/services/notifications', `export const setUnreadBadgeCount=()=>{},loadMutedConvs=async()=>({}),muteConversation=async()=>{},setActiveConversationForNotifications=()=>{};`);
mock('/services/clientLogger', `export const logError=()=>{};`);
mock('/services/haptics', `export const hapticSend=()=>{},hapticReceive=()=>{};`);
mock('/services/attachments', `export const MAX_IMAGES_PER_MESSAGE=10,pickImages=async()=>[],takePhoto=async()=>null,filesToAssets=async()=>[],releaseAsset=()=>{},uploadImage=()=>{};`);
mock('/services/exportDownload', `export const saveJsonDownload=()=>{};`);
mock('/services/hashtagSuggestions', `export const fetchHashtagSuggestions=async()=>[],invalidateHashtagSuggestions=()=>{};`);
mock('/services/ideaflowSignIn', `export const markIdeaflowAccountChoice=()=>{};`);
mock('/services/ideaflowNativeSignIn', `export const markIdeaflowAccountChoiceNative=()=>{};`);
mock('/services/ideaflowAutoSignIn', `export const clearIdeaflowSignedOut=()=>{},markIdeaflowSignedOut=()=>{};`);
for(const name of ['MessageActionSheet','ReactionsBar','ToastMessage','AiDisclosureBanner','BotBadge','JumpToBottomButton','VoiceMessageBubble','HashtagAutocomplete','TransformButton','NVCComposerModal','LinkPreviewCard','AgentNetworkCard','AgentOverlayButton','ExportSheet']) mock('/components/'+name, `export const ${name}=()=>null;`);
mock('/components/InAppMessageBanner', `export const showInAppBanner=()=>{};`);
mock('@react-navigation/native', `export {useFocusEffect,useRoute,useNavigation} from './apps/server/test/fixtures/conversationNavigation';`);
mock('@react-navigation/elements', `export const useHeaderHeight=()=>56;`);
mock('react-native', `export * from 'react-native-web';export const ActionSheetIOS={showActionSheetWithOptions(){}};`);
mock('expo-clipboard', `export const setStringAsync=async()=>{};`);
mock('expo-crypto', `export const randomUUID=()=>crypto.randomUUID();`);
const entry=`import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';import {ChatProvider,useChat} from './apps/mobile/src/contexts/ChatContext';import {OfflineBanner} from './apps/mobile/src/components/OfflineBanner';import {SafeAreaProvider} from 'react-native-safe-area-context';import {ChatScreen} from './apps/mobile/src/screens/ChatScreen';function Product(){const chat=useChat();window.chatFixture=chat;useEffect(()=>{void chat.bootstrapIfAuthed();},[]);return chat.authInitialized ? <SafeAreaProvider initialMetrics={{insets:{top:0,left:0,bottom:0,right:0},frame:{x:0,y:0,width:390,height:844}}}><OfflineBanner/><ChatScreen conversationId="sailing"/></SafeAreaProvider> : null;}createRoot(document.getElementById('root')).render(<ChatProvider><Product/></ChatProvider>);`;
await build({stdin:{contents:entry,loader:'tsx',resolveDir:process.cwd()},bundle:true,outfile:path.join(out,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],define:{global:'globalThis','process.env':'{}','process.env.NODE_ENV':'"development"','__DEV__':'true'},plugins:[{name:'fixture-boundaries',setup(b){b.onResolve({filter:/.*/},args=>{for(const [suffix] of mocks){if(args.path===suffix||args.path.replace(/\.(js|tsx?)$/,'').endsWith(suffix))return{path:suffix,namespace:'fixture'};}if(args.path==='react-native')return{path:path.resolve('node_modules/react-native-web/dist/index.js')};});b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks.get(args.path),loader:'js',resolveDir:process.cwd()}));}}]});
await writeFile(path.join(out,'index.html'),`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenChat conversation fixture</title><style>html,body,#root{margin:0;height:100%;display:flex;flex-direction:column}body{font-family:Arial,sans-serif}</style><div id="root"></div><script src="fixture.js"></script>`);
console.log('Synthetic offline-chat fixture built:',out);
