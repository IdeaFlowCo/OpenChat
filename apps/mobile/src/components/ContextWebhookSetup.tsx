import React, { useRef, useState } from 'react';
import { Clipboard, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { api, type AgentKey, type Conversation, type ContextWebhookSubscription } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

/** Explicit endpoint consent is separate from hosted drafts and key inbox opt-in. */
export function ContextWebhookSetup() {
 const c=getColors(useTheme().scheme);
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[available,setAvailable]=useState(false);
 const [keys,setKeys]=useState<AgentKey[]>([]),[rooms,setRooms]=useState<Conversation[]>([]),[subscriptions,setSubscriptions]=useState<ContextWebhookSubscription[]>([]);
 const [keyId,setKeyId]=useState(''),[roomId,setRoomId]=useState(''),[url,setUrl]=useState(''),[approved,setApproved]=useState(false);
 const [secret,setSecret]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const requestId=useRef('');
 const reset=()=>{setApproved(false);setSecret('');setNotice('');requestId.current='';};
 const button=(label:string,onPress:()=>void,disabled=busy)=> <TouchableOpacity accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={onPress} style={[styles.button,{borderColor:c.border}]}><Text style={{color:disabled?c.textMetadata:c.primary,fontWeight:'600'}}>{label}</Text></TouchableOpacity>;
 async function load() {
  setOpen(true);setBusy(true);setError('');
  try {
   const [state,allKeys,conversations]=await Promise.all([api.getContextWebhooks(),api.listAgentKeys(),api.getConversations()]);
   const active=allKeys.filter(k=>!k.revokedAt&&(!k.expiresAt||Date.parse(k.expiresAt)>Date.now())&&k.scopes.includes('read')&&k.scopes.includes('write'));
   const preferences=await Promise.all(active.map(async k=>({key:k,enabled:(await api.getContextAgentPreferences(k.id)).enabled})));
   setAvailable(state.available);setSubscriptions(state.subscriptions);setKeys(preferences.filter(p=>p.enabled).map(p=>p.key));setRooms(conversations);
  }catch(e){setError(e instanceof Error?e.message:'Could not load webhook setup');}finally{setBusy(false);}
 }
 async function create() {
  if(!approved||!available||!keyId||!roomId||!url.trim()||busy)return;
  setBusy(true);setError('');setNotice('');
  requestId.current ||= `webhook-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try{const result=await api.createContextWebhook({url:url.trim(),agentKeyId:keyId,conversationId:roomId,clientRequestId:requestId.current,consent:true});
   setSecret(result.secret);setSubscriptions(previous=>[...previous.filter(s=>s.id!==result.subscription.id),result.subscription]);setApproved(false);setNotice('Webhook enabled for future requests. Store the signing secret in your receiver.');
  }catch(e){setError(e instanceof Error?e.message:'Could not create subscription');}finally{setBusy(false);}
 }
 async function remove(id:string){setBusy(true);setError('');try{await api.deleteContextWebhook(id);setSubscriptions(previous=>previous.filter(s=>s.id!==id));setSecret('');setNotice('Webhook disabled. Pending deliveries cancelled.');}catch(e){setError(e instanceof Error?e.message:'Could not disable subscription');}finally{setBusy(false);}}
 const roomLabel=(r:Conversation)=>r.title||r.participants?.map(p=>p.user.name).join(', ')||'Conversation';
 return <View style={[styles.panel,{backgroundColor:c.surface,borderColor:c.border}]}>
  <Text style={[styles.heading,{color:c.textPrimary}]}>External agent webhooks</Text>
  <Text style={[styles.detail,{color:c.textMetadata}]}>Optional wake-ups for an agent you run. Your agent still uses its API key to fetch shared Context requests.</Text>
  {!open?button('Set up webhooks',()=>void load()):<>
   {!available&&<Text style={[styles.detail,{color:c.textMetadata}]}>Webhook delivery is disabled on this server. Existing API-key polling remains available.</Text>}
   <Text style={[styles.detail,{color:c.textMetadata}]}>Choose a read/write key with Context requests already enabled in Agent setup. Hosted drafts take priority while your hosted agent is on.</Text>
   <Text style={[styles.label,{color:c.textPrimary}]}>Receiving API key</Text>
   {keys.length?keys.map(k=><View key={k.id}>{button(`${keyId===k.id?'Selected · ':''}${k.name}`,()=>{reset();setKeyId(k.id);})}</View>):<Text style={{color:c.textMetadata}}>No eligible keys. Enable Context requests for a key in Agent setup.</Text>}
   <Text style={[styles.label,{color:c.textPrimary}]}>Conversation</Text>
   {rooms.map(r=><View key={r.id}>{button(`${roomId===r.id?'Selected · ':''}${roomLabel(r)}`,()=>{reset();setRoomId(r.id);})}</View>)}
   <Text style={[styles.label,{color:c.textPrimary}]}>Public HTTPS endpoint</Text>
   <TextInput accessibilityLabel="Webhook HTTPS endpoint" autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy} value={url} onChangeText={value=>{reset();setUrl(value);}} placeholder="https://your-agent.example/context" placeholderTextColor={c.textMetadata} style={[styles.input,{color:c.textPrimary,borderColor:c.border}]}/>
   <Text style={[styles.detail,{color:c.textMetadata}]}>This endpoint will receive an event ID and request ID whenever someone explicitly asks your agent in the selected conversation. No post text, private notes, or messages are included. This does not authorize your agent to disclose private material.</Text>
   {button(approved?'Approved · Change approval':'Approve sending request IDs to this endpoint',()=>setApproved(!approved),busy||!available||!keyId||!roomId||!url.trim())}
   {approved&&<Text style={[styles.detail,{color:c.textPrimary}]}>{url.trim()} · {rooms.find(r=>r.id===roomId)?roomLabel(rooms.find(r=>r.id===roomId)!):roomId} · {keys.find(k=>k.id===keyId)?.name}</Text>}
   {button(busy?'Saving…':'Enable webhook',()=>void create(),busy||!available||!approved)}
   {!!secret&&<View><Text style={[styles.label,{color:c.textPrimary}]}>Signing secret</Text><Text selectable style={[styles.detail,{color:c.textPrimary}]}>{secret}</Text>{button('Copy signing secret',()=>{Clipboard.setString(secret);setNotice('Signing secret copied.');})}</View>}
   {subscriptions.filter(s=>s.enabled).map(s=><View key={s.id} style={[styles.subscription,{borderColor:c.border}]}><Text style={[styles.detail,{color:c.textPrimary}]}>{s.url}</Text><Text style={[styles.detail,{color:c.textMetadata}]}>{rooms.find(r=>r.id===s.conversationId)?roomLabel(rooms.find(r=>r.id===s.conversationId)!):'Conversation unavailable'} · {keys.find(k=>k.id===s.agentKeyId)?.name||'Key unavailable'}</Text>{button('Disable webhook',()=>void remove(s.id))}</View>)}
   {button('Refresh webhook setup',()=>void load())}
  </>}
  {!!error&&<Text accessibilityRole="alert" style={[styles.detail,{color:c.danger}]}>{error}</Text>}
  {!!notice&&<Text accessibilityLiveRegion="polite" style={[styles.detail,{color:c.textMetadata}]}>{notice}</Text>}
 </View>;
}
const styles=StyleSheet.create({panel:{padding:16,borderWidth:StyleSheet.hairlineWidth,borderRadius:10,marginTop:18},heading:{fontSize:15,fontWeight:'600'},detail:{fontSize:14,lineHeight:22,marginTop:8},label:{fontSize:14,fontWeight:'600',marginTop:16,marginBottom:6},button:{minHeight:44,justifyContent:'center',paddingHorizontal:12,paddingVertical:8,borderWidth:StyleSheet.hairlineWidth,borderRadius:8,marginTop:8,alignSelf:'flex-start'},input:{minHeight:44,borderWidth:1,borderRadius:8,padding:10,fontSize:14},subscription:{marginTop:16,paddingTop:8,borderTopWidth:StyleSheet.hairlineWidth}});
