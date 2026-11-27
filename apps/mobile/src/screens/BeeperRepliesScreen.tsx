import {useCallback,useLayoutEffect,useRef,useState} from 'react';
import {ActivityIndicator,Alert,Platform,ScrollView,StyleSheet,Text,TextInput,View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import * as Crypto from 'expo-crypto';
import {Buffer} from 'buffer';
import {api} from '../api/client';
import {useChat} from '../contexts/ChatContext';
import {useTheme} from '../contexts/ThemeContext';
import {getColors} from '../theme/colors';
import {Button,Card,Chip,ListRow,SectionLabel} from '../components/ui';
import {radius,roles,space,type} from '../theme/tokens';
import {importWriteOffer,listWriteGrants,prepareSend,getSendDisplay,markSubmitAttempt,resumeSubmittedSend,recordSendReceipt,disableWriteGrant,cancelPreparedSend} from '../services/beeper/writeRegistry';
type Grant=Awaited<ReturnType<typeof listWriteGrants>>[number];
type Operation=Awaited<ReturnType<typeof getSendDisplay>>;
const terminal=(state:string)=>['confirmed','failed','cancelled'].includes(state);
const labels:Record<string,string>={prepared:'Reply ready for review',submitted:'Waiting for Mac approval',review:'Waiting for Mac approval',approved:'Approved on Mac',attempted:'Send attempt recorded',pending:'Beeper is confirming the send',unknown:'Send outcome unknown — do not send again',confirmed:'Beeper confirmed the send',failed:'Beeper reported a permanent failure',cancelled:'Reply cancelled before sending'};
const label=(state:string)=>labels[state]||'Waiting for authenticated Mac status';
export function BeeperRepliesScreen(){
 const {currentUser,isIdentityVerified}=useChat(),owner=isIdentityVerified?currentUser?.userId:undefined,live=useRef(owner);live.current=owner;
 return owner?<Replies key={owner} owner={owner} current={()=>live.current===owner}/>:<Text>Verifying your account…</Text>;
}
function Replies({owner,current}:{owner:string;current:()=>boolean}){
 const r=roles(getColors(useTheme().scheme)),live=useRef(true),currentRef=useRef(current);currentRef.current=current;useLayoutEffect(()=>()=>{live.current=false;},[]);
 const valid=useCallback(()=>live.current&&currentRef.current(),[]);
 const [grants,setGrants]=useState<Grant[]|null>(null),[selected,setSelected]=useState(''),[wire,setWire]=useState(''),[draft,setDraft]=useState({route:'',text:''}),[operation,setOperation]=useState<Operation|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const selectedRef=useRef(selected);selectedRef.current=selected;const pending=useRef(false),opRef=useRef(operation);opRef.current=operation;
 const text=draft.route===selected?draft.text:'';const setText=(value:string)=>setDraft({route:selectedRef.current,text:value});
 const load=useCallback(async()=>{if(Platform.OS==='web'||!valid())return;try{const value=await listWriteGrants(owner);if(valid()){setGrants(value);setSelected(previous=>value.some(g=>g.connectionId===previous)?previous:value[0]?.connectionId??'');}}catch{if(valid())setError('Approve a write grant on your paired Mac and native device before replying.');}},[owner,valid]);
 useFocusEffect(useCallback(()=>{live.current=true;void load();return()=>{live.current=false;};},[load]));
 const grant=grants?.find(g=>g.connectionId===selected),scope=useRef(grant);scope.current=grant;
 const visibleOperation=operation?.connectionId===selected&&operation.chatKey===grant?.chatKey?operation:null;opRef.current=visibleOperation;
 useLayoutEffect(()=>{setOperation(previous=>previous?.connectionId===selected&&previous.chatKey===grant?.chatKey?previous:null);setText('');const route=selected;let active=true;const id=grant?.pendingOperationId;
  if(id)void getSendDisplay(owner,id).then(value=>{if(active&&valid()&&selectedRef.current===route)setOperation(value);}).catch(()=>{if(active&&valid())setError('This reply needs local review. Its original Mac and operation are preserved.');});
  return()=>{active=false;};
 },[owner,selected,grant?.pendingOperationId,valid]);
 const report=async(op:Operation)=>{
  const still=()=>valid()&&selectedRef.current===op.connectionId&&opRef.current?.operationId===op.operationId;
  if(!still())return;
  const result=await api.getBeeperSend(op.connectionId,op.operationId);
  if(!still())return;
  // Neither HTTP200, transportState nor an unsigned flag is proof of a send.
  if(result.operationId!==op.operationId)throw Error('scope_mismatch');
  if(result.receipt){await recordSendReceipt(owner,op.operationId,result.receipt);if(!still())return;const value=await getSendDisplay(owner,op.operationId);if(still()){setOperation(value);setError('');if(terminal(value.state))await load();}}
 };
 const reportRef=useRef(report);reportRef.current=report;
 useFocusEffect(useCallback(()=>{
  const captured=visibleOperation;if(!captured||captured.state==='prepared'||terminal(captured.state)||Platform.OS==='web')return;
  let active=true,timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{await reportRef.current(captured);}catch{if(active&&valid())setError('No authenticated update yet. This does not prove the reply was unsent.');}finally{if(active&&valid())timer=setTimeout(()=>{void poll();},3000);}};
  void poll();return()=>{active=false;clearTimeout(timer);};
 },[visibleOperation?.operationId,visibleOperation?.state,valid]));
 const action=async(work:()=>Promise<void>)=>{if(pending.current||!valid())return;pending.current=true;setBusy(true);setError('');try{await work();}catch{if(valid())setError('This operation needs review on your paired device or Mac. No new reply was created.');}finally{pending.current=false;if(valid())setBusy(false);}};
 const importGrant=()=>action(async()=>{
  if(Platform.OS==='web'||!wire.trim())return;
  const offer=await importWriteOffer(owner,wire.trim(),view=>new Promise(resolve=>{
   if(!valid()){resolve(false);return;}
   Alert.alert('Approve replies to this chat',`${view.title}\nWhatsApp · Mac ${view.machineKey.slice(0,12)}…\nUntil ${new Date(view.expiresAt).toLocaleString()}.\nEach reply still requires your Send action and local Mac approval. This does not authorize other chats.`,[{text:'Cancel',style:'cancel',onPress:()=>resolve(false)},{text:'Approve write grant',onPress:()=>resolve(valid())}],{cancelable:true,onDismiss:()=>resolve(false)});
  }));
  if(!valid())return;await api.approveBeeperWriteConnection(offer);if(valid()){setWire('');await load();setSelected(offer.connectionId);}
 });
 const review=()=>action(async()=>{
  const target=scope.current,body=text;if(!target||target.pendingOperationId||!body.trim())return;if(Buffer.byteLength(body,'utf8')>16000){setError('This reply is too long. Shorten it before reviewing.');return;}
  const id=Array.from(await Crypto.getRandomBytesAsync(24),v=>v.toString(16).padStart(2,'0')).join('');if(!valid()||selectedRef.current!==target.connectionId)return;
  await prepareSend(owner,target.connectionId,target.chatKey,{operationId:id,text:body});if(!valid()||selectedRef.current!==target.connectionId)return;
  const value=await getSendDisplay(owner,id);if(valid()&&selectedRef.current===target.connectionId){setOperation(value);setText('');await load();}
 });
 const submit=(retry=false)=>action(async()=>{
  const captured=opRef.current;if(!captured||!valid()||selectedRef.current!==captured.connectionId)return;
  // This durable native transition PRECEDES the first cloud POST. A retry returns
  // byte-identical ciphertext for the original route/Mac, never a new signature.
  const input=retry?await resumeSubmittedSend(owner,captured.operationId):await markSubmitAttempt(owner,captured.operationId);
  if(!valid()||selectedRef.current!==captured.connectionId)return;
  const value=await getSendDisplay(owner,captured.operationId);if(!valid())return;setOperation(value);
  await api.enqueueBeeperSend(input);if(valid())await reportRef.current(value);
 });
 const revoke=()=>action(async()=>{const target=scope.current;if(!target)return;await disableWriteGrant(owner,target.connectionId);if(!valid())return;try{await api.revokeBeeperWriteConnection(target.connectionId);}finally{if(valid()){setOperation(null);await load();}}});
 return <ScrollView style={{flex:1,backgroundColor:r.canvas}} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}><View style={styles.content}>
  <View style={styles.heading}><Text accessibilityRole="header" style={[type.heading,{color:r.text}]}>Beeper replies</Text><Chip label="Separate write approval"/></View>
  <Text style={[type.body,{color:r.textMeta}]}>Reply only to a chat you approved on your Mac and this native device. A read-only connection cannot send messages. iMessage is not enabled here.</Text>
  {Platform.OS==='web'?<Card><Text style={[type.body,{color:r.text}]}>Use the paired native OpenChat app to approve and send replies. Saved conversations remain available on the web.</Text></Card>:<>
   {!!error&&<Text accessibilityRole="alert" style={[type.body,{color:r.danger}]}>{error}</Text>}
   <Card style={styles.form}><SectionLabel>Approve a selected chat</SectionLabel><Text style={[type.body,{color:r.textMeta}]}>Paste the encrypted write grant from your Mac. It names one chat, the paired keys and an expiry. Paste no token or private key.</Text>
    <TextInput accessibilityLabel="Encrypted write grant" placeholder="Paste encrypted write grant" multiline value={wire} onChangeText={setWire} autoCapitalize="none" autoCorrect={false} maxLength={16000} style={[styles.input,{color:r.text,borderColor:r.line,backgroundColor:r.input}]}/>
    <Button label="Review write grant" disabled={!wire.trim()||busy} loading={busy} onPress={()=>{void importGrant();}}/>
   </Card><SectionLabel>Approved reply targets</SectionLabel><Button label="Reload approved targets" variant="ghost" onPress={()=>{void load();}}/>
   {grants===null&&!error&&<ActivityIndicator accessibilityLabel="Loading approved write grants" color={r.accent}/>}
   {grants?.length===0&&<Text style={[type.body,{color:r.textMeta}]}>No active write grant on this device. Approving a read-only source chat does not enable replies.</Text>}
   {grants?.map(g=><Card key={g.connectionId} padding="none"><ListRow title={g.title} subtitle={`WhatsApp · Mac ${g.machineKey.slice(0,12)}… · expires ${new Date(g.expiresAt).toLocaleString()}`} trailing={<Chip label={selected===g.connectionId?'Selected':'Select'}/>} onPress={()=>{if(!busy){setError('');setSelected(g.connectionId);}}}/></Card>)}
   {grant&&<>
    <Button label="Reconnect private relay" variant="ghost" loading={busy} onPress={()=>{void action(async()=>{const target=scope.current;if(!target)return;const {title:_title,chatType:_chatType,network:_network,pendingOperationId:_pending,...offer}=target;await api.approveBeeperWriteConnection(offer);});}}/>

    {visibleOperation?<Card style={styles.form}><Text accessibilityRole="header" style={[type.title,{color:r.text}]}>{label(visibleOperation.state)}</Text><Text style={[type.body,{color:r.textMeta}]}>{`To ${visibleOperation.title} · original Mac ${grant.machineKey.slice(0,12)}…`}</Text><Text selectable style={[type.body,{color:r.text}]}>{visibleOperation.text}</Text>
      {visibleOperation.state==='prepared'?<><Button label="Send reply for Mac approval" variant="primary" loading={busy} onPress={()=>{void submit();}}/><Button label="Discard prepared reply" variant="ghost" disabled={busy} onPress={()=>{void action(async()=>{const op=opRef.current;if(!op)return;await cancelPreparedSend(owner,op.operationId);if(valid()){setOperation(null);await load();}});}}/></>:!terminal(visibleOperation.state)&&<>
       <Text style={[type.body,{color:r.textMeta}]}>An uncertain send stays with this operation and Mac. Do not create another reply to retry it. A cloud acknowledgment is not delivery confirmation.</Text>
       <Button label="Check reply status" loading={busy} onPress={()=>{void action(()=>reportRef.current(visibleOperation));}}/>
       <Button label="Retry the same request" variant="ghost" loading={busy} onPress={()=>{void submit(true);}}/>
      </>}
      {terminal(visibleOperation.state)&&<Button label="Write another reply" onPress={()=>{setOperation(null);void load();}}/>}
     </Card>:<Card style={styles.form}><Text accessibilityRole="header" style={[type.title,{color:r.text}]}>{`Reply to ${grant.title}`}</Text><TextInput accessibilityLabel="Reply message" placeholder="Write a reply" multiline value={text} onChangeText={setText} maxLength={16000} style={[styles.input,styles.message,{color:r.text,borderColor:r.line,backgroundColor:r.input}]}/><Button label="Review reply" disabled={!text.trim()||busy} onPress={()=>{void review();}}/></Card>}
    <Text style={[type.body,{color:r.textMeta}]}>Disabling this device grant stops future authorizations. Revoke locally on your Mac to stop a request already admitted there.</Text>
    <Button label="Disable this write grant" variant="destructive" loading={busy} onPress={()=>{void revoke();}} accessibilityHint="Disables future native authorizations. Revoke locally on Mac to stop a request already admitted there."/>
   </>}
  </>}
 </View></ScrollView>;
}
const styles=StyleSheet.create({page:{padding:space[6]},content:{width:'100%',maxWidth:720,alignSelf:'center',gap:space[6]},heading:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:space[4]},form:{gap:space[4]},input:{borderWidth:1,borderRadius:radius.md,padding:space[4],minHeight:80},message:{minHeight:160}});
