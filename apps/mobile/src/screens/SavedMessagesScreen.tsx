/** Direct retrieval door: people and source threads, with owner-private pins.
 * Existing Ink & Paper tokens, system sans, 4px rhythm, 16px item padding.
 * Saved words lead; the person/channel/date remain visible as source context. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { CommonActions, useFocusEffect, useNavigation } from '@react-navigation/native';
import { api, OPENCHAT_URL } from '../api/client';
import type { MessageCapture, CaptureThread } from '../types/messageCaptures';
import type { ThoughtsNavProp } from '../navigation/types';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { useIsDesktop } from '../theme/breakpoints';
import { isLocalOnlyCapture, LOCAL_ONLY_CAPTURE_MESSAGE } from '../utils/captureConfidentiality';
import { streamErrorMessage } from './streamError';

export function SavedMessagesScreen() {
  const {scheme}=useTheme(), c=getColors(scheme), wide=useIsDesktop();
  const navigation=useNavigation<ThoughtsNavProp<'SavedMessages'>>();
  const [details,setDetails]=useState(false),[adding,setAdding]=useState(false),[draft,setDraft]=useState(''),[field,setField]=useState(''),[draftPin,setDraftPin]=useState(false),[localOnly,setLocalOnly]=useState(false);
  const [threads,setThreads]=useState<CaptureThread[]>([]),[threadId,setThreadId]=useState('');
  const [items,setItems]=useState<MessageCapture[]>([]),[cursor,setCursor]=useState<string>();
  const [query,setQuery]=useState(''),[search,setSearch]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const [selected,setSelected]=useState<MessageCapture|null>(null),[tags,setTags]=useState(''),[busy,setBusy]=useState(false),[forget,setForget]=useState(false);
  const [setup,setSetup]=useState(false),[deviceName,setDeviceName]=useState('My Mac'),[credential,setCredential]=useState('');
  const [devices,setDevices]=useState<{id:string;name:string;lastSeenAt:string|null}[]>([]);
  const generation=useRef(0), busyRef=useRef(false);
  useEffect(()=>{const timer=setTimeout(()=>setSearch(query.trim()),250);return()=>clearTimeout(timer);},[query]);
  const load=useCallback(async()=>{
    const version=++generation.current;setLoading(true);setError('');
    try{
      const [page,groups]=await Promise.all([api.getMessageCaptures({threadId,search,destination:details?'contact':undefined}),api.getCaptureThreads()]);
      if(version!==generation.current)return;
      setItems(page.items);setCursor(page.nextCursor);setThreads(groups.threads);
    }catch(e){if(version===generation.current)setError(streamErrorMessage(e,'Could not load saved messages'));}
    finally{if(version===generation.current)setLoading(false);}
  },[threadId,search,details]);
  useFocusEffect(useCallback(()=>{void load();return()=>{generation.current++;};},[load]));
  const more=async()=>{
    if(!cursor||loading)return;
    const version=generation.current;setLoading(true);
    try{const page=await api.getMessageCaptures({threadId,search,cursor,destination:details?'contact':undefined});if(version===generation.current){setItems(prev=>[...prev,...page.items.filter(x=>!prev.some(p=>p.id===x.id))]);setCursor(page.nextCursor);}}
    catch(e){if(version===generation.current)setError(streamErrorMessage(e,'Could not load more'));}
    finally{if(version===generation.current)setLoading(false);}
  };
  const action=async(fn:()=>Promise<void>)=>{
    if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');
    try{await fn();}catch(e){setError(streamErrorMessage(e,'Could not save that change'));}
    finally{busyRef.current=false;setBusy(false);}
  };
  const button=(label:string,onPress:()=>void,active=false)=> <TouchableOpacity key={label} accessibilityRole="button" accessibilityState={{selected:active,disabled:busy}} disabled={busy} onPress={onPress} style={[styles.button,{borderColor:active?c.primary:c.border,backgroundColor:active?c.primaryMuted:c.surface}]}><Text style={{color:active?c.primary:c.textPrimary,fontWeight:'500'}}>{label}</Text></TouchableOpacity>;
  const show=(item:MessageCapture)=>{setSelected(item);setTags(item.tags.join(' '));setForget(false);};
  const thread=threads.find(t=>t.id===threadId);
  const title=thread?.title||'All saved';
  const chooseThread=(id:string)=>{setThreadId(id);setDetails(false);};
  const openConnections=()=>void action(async()=>{const {person}=await api.getCapturedPerson(threadId);navigation.dispatch(CommonActions.navigate({name:'Main',params:{screen:'ChatsTab',params:{screen:'PrivateThing',params:{thingId:person.id}}}}));});
  const openAdd=()=>{setLocalOnly(false);setDraft('');setField('');setDraftPin(false);setAdding(true);};
  const openSetup=()=>{setSetup(true);setCredential('');void action(async()=>{setDevices((await api.getCaptureDevices()).devices);});};
  return <View style={[styles.root,{backgroundColor:c.background}]}>
    <View style={[styles.doors,{borderColor:c.border}]}>{button('Saved from messages',()=>chooseThread(''),true)}{button('My notes',()=>navigation.navigate('ThoughtsList'))}{button('Mac companion',openSetup)}{button('＋ Add',openAdd)}</View>
    <View style={[styles.body,wide&&styles.wide]}>
      <View style={[wide?styles.sidebar:styles.threadStrip,{borderColor:c.border}]}>
        <ScrollView horizontal={!wide} contentContainerStyle={wide?styles.threadList:styles.horizontal}>
          {button('All saved',()=>chooseThread(''),!threadId)}
          {threads.map(t=><TouchableOpacity key={t.id} accessibilityRole="button" accessibilityState={{selected:t.id===threadId}} onPress={()=>chooseThread(t.id)} style={[styles.thread,{borderColor:t.id===threadId?c.primary:c.border,backgroundColor:t.id===threadId?c.primaryMuted:c.surface}]}><Text numberOfLines={2} style={{color:c.textPrimary,fontWeight:'600'}}>{t.title}</Text><Text style={[styles.meta,{color:c.textMetadata}]}>{t.channel==='imessage'?'iMessage':t.channel} · {t.count} saved</Text></TouchableOpacity>)}
        </ScrollView>
      </View>
      <View style={styles.content}>
        <View style={styles.heading}><Text accessibilityRole="header" style={[styles.title,{color:c.textPrimary}]}>{title}</Text><Text style={[styles.meta,{color:c.textMetadata}]}>Only you</Text></View>
        {!!threadId&&<View style={styles.row}>{button('Stream',()=>setDetails(false),!details)}{thread?.participants?.length===1&&button('Contact details',()=>setDetails(true),details)}</View>}
        {details&&<View style={styles.device}><Text style={[styles.label,{color:c.textPrimary}]}>{thread?.title}</Text>{thread?.participants?.map(p=><Text key={p} selectable style={{color:c.textMetadata}}>{p}</Text>)}<Text style={[styles.meta,{color:c.textMetadata}]}>Private details from saved items. Pinning a detail also places it at the top of this stream.</Text>{button('Connections and notes',openConnections)}{!!thread?.contactDetails?.length&&<View style={styles.device}><Text style={[styles.label,{color:c.textPrimary}]}>From Apple Contacts</Text>{thread.contactDetails.map((f,i)=><View key={i} style={{gap:4,paddingVertical:8}}><Text style={[styles.meta,{color:c.textMetadata}]}>{f.label}</Text><Text selectable style={{color:c.textPrimary}}>{f.value}</Text></View>)}</View>}</View>}
        <TextInput accessibilityLabel="Search saved messages" placeholder="Search words, people, or #tags" placeholderTextColor={c.textMetadata} value={query} onChangeText={setQuery} style={[styles.input,{color:c.textPrimary,borderColor:c.border,backgroundColor:c.surfaceElevated}]}/>
        {!!error&&<View accessibilityRole="alert" style={styles.error}><Text style={{color:c.danger}}>{error}</Text>{button('Retry',()=>void load())}</View>}
        <FlatList data={items} keyExtractor={item=>item.id} refreshing={loading} onRefresh={()=>void load()} contentContainerStyle={styles.entries}
          ListEmptyComponent={!loading?<View style={styles.empty}><Text style={[styles.subtitle,{color:c.textPrimary}]}>{search?'No saved messages match':details?'Add a contact detail':'Add something worth keeping'}</Text><Text style={[styles.explanation,{color:c.textMetadata}]}>{search?'Try another word or clear your search.':details?'Add an address, phone, birthday, or another detail. Each stays private to you.':'Use Add to write a note or paste a link. You can also connect your Mac and save from iMessage with a #tag, 🔖, or 📌.'}</Text></View>:<ActivityIndicator color={c.primary}/>}
          renderItem={({item})=><View style={[styles.entry,{borderColor:c.border,backgroundColor:item.pinned?c.surfaceElevated:c.surface}]}>
            <View style={styles.heading}><TouchableOpacity accessibilityRole="button" accessibilityLabel={`Open details for ${item.threadTitle}`} onPress={()=>{setThreadId(item.threadId);setDetails(threads.find(t=>t.id===item.threadId)?.participants?.length===1);}} style={{flex:1,minHeight:44,justifyContent:'center'}}><Text style={[styles.meta,{color:c.primary}]}>{item.threadTitle} · {item.channel==='imessage'?'iMessage':item.channel==='manual'?'Added here':item.channel}</Text></TouchableOpacity>{item.pinned&&<Text style={[styles.meta,{color:c.primary}]}>📌 Pinned</Text>}</View>
            {item.destination==='contact'&&<Text style={[styles.meta,{color:c.primary}]}>{item.contactLabel||'Contact detail'}</Text>}
            <Text selectable style={[styles.captureText,{color:c.textPrimary}]}>{item.text}</Text>
            <View style={styles.tags}>{item.tags.map(tag=><TouchableOpacity key={tag} accessibilityRole="button" accessibilityLabel={`Filter by ${tag}`} onPress={()=>setQuery('#'+tag)} style={[styles.tag,{backgroundColor:c.surfaceElevated}]}><Text style={{color:c.primary}}>#{tag}</Text></TouchableOpacity>)}</View>
            <View style={styles.heading}><Text style={[styles.meta,{color:c.textMetadata}]}>{new Date(item.sourceAt).toLocaleDateString()}</Text><View style={styles.row}>{button(item.captureMethod==='direct'?'Details':'View source',()=>show(item))}{button(item.pinned?'Unpin':'Pin',()=>void action(async()=>{await api.updateMessageCapture(item.id,{pinned:!item.pinned});await load();}))}</View></View>
          </View>}
          ListFooterComponent={cursor?button(loading?'Loading…':'Load more',()=>void more()):<Text style={[styles.footer,{color:c.textMetadata}]}>Saved from your conversations. Pinning here is private.</Text>}/>
      </View>
    </View>
    <Modal visible={!!selected||setup||adding} transparent animationType="fade" onRequestClose={()=>{if(!busy){setSelected(null);setSetup(false);setAdding(false);setCredential('');}}}>
      <View style={styles.shade}><View accessibilityViewIsModal style={[styles.modal,{backgroundColor:c.surface,borderColor:c.border}]}><ScrollView>
        {adding?<><Text accessibilityRole="header" style={[styles.title,{color:c.textPrimary}]}>{details?'Add contact detail':'Add to stream'}</Text><Text style={[styles.explanation,{color:c.textMetadata}]}>{thread?thread.title:'My notes · just me'} · Only you</Text>{details&&<TextInput accessibilityLabel="Contact field name" placeholder="Mailing address, phone, birthday…" placeholderTextColor={c.textMetadata} value={field} onChangeText={setField} style={[styles.input,{borderColor:c.border,color:c.textPrimary}]}/>}<TextInput accessibilityLabel={details?'Contact detail value':'New note or link'} multiline autoFocus placeholder={details?'Enter the detail':'Write a note or paste a link. Add #tags if you like.'} placeholderTextColor={c.textMetadata} value={draft} onChangeText={setDraft} style={[styles.input,{borderColor:c.border,color:c.textPrimary,minHeight:140,textAlignVertical:'top'}]}/>{button(draftPin?'📌 Pinned to top':'Also pin to top',()=>setDraftPin(!draftPin),draftPin)}{localOnly&&<Text accessibilityRole="alert" style={{color:c.danger}}>{LOCAL_ONLY_CAPTURE_MESSAGE}</Text>}{button('Add',()=>void action(async()=>{if(isLocalOnlyCapture(draft,details?field:'')){setLocalOnly(true);return;}setLocalOnly(false);const tags=Array.from(draft.matchAll(/(?:^|\s)#([\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]*)/gu),m=>m[1]);await api.addMessageCapture({text:draft,threadId:threadId||undefined,destination:details?'contact':'stream',contactLabel:details?field:undefined,tags,pinned:draftPin});setAdding(false);setDraft('');await load();}))}</>:selected?<><Text accessibilityRole="header" style={[styles.title,{color:c.textPrimary}]}>{selected.captureMethod==='direct'?'Saved entry':'Original message'}</Text><Text style={[styles.explanation,{color:c.textMetadata}]}>{selected.threadTitle} · {selected.channel} · {new Date(selected.sourceAt).toLocaleString()}</Text><Text selectable style={[styles.captureText,{color:c.textPrimary}]}>{selected.text}</Text><Text style={[styles.meta,{color:c.textMetadata}]}>Saved via {selected.captureMethod} · {selected.triggerText||'Emoji reaction'}</Text><Text style={[styles.label,{color:c.textPrimary}]}>Tags</Text><TextInput accessibilityLabel="Saved message tags" value={tags} onChangeText={setTags} style={[styles.input,{borderColor:c.border,color:c.textPrimary}]}/>{button('Save tags',()=>void action(async()=>{await api.updateMessageCapture(selected.id,{tags:tags.split(/[\s,]+/).map(t=>t.replace(/^#/, '')).filter(Boolean)});setSelected(null);await load();}))}
          {button('Forget saved item',()=>setForget(true))}{forget&&<View><Text style={[styles.explanation,{color:c.textMetadata}]}>Remove this saved copy and its source snapshot. The message in iMessage stays. Replaying the archive will not restore it.</Text>{button('Confirm forget',()=>void action(async()=>{await api.forgetMessageCapture(selected.id);setSelected(null);await load();}))}</View>}</>:
        <><Text accessibilityRole="header" style={[styles.title,{color:c.textPrimary}]}>Mac companion</Text><Text style={[styles.explanation,{color:c.textMetadata}]}>An always-on Mac saves your tagged iMessages here. The companion can add captures; its credential cannot read your saved library. Run it with or without the OpenChat window.</Text>
          {devices.map(d=><View key={d.id} style={styles.device}><Text style={{color:c.textPrimary}}>{d.name}</Text><Text style={[styles.meta,{color:c.textMetadata}]}>{d.lastSeenAt?'Last connected '+new Date(d.lastSeenAt).toLocaleString():'Waiting for first connection'}</Text>{button('Disconnect '+d.name,()=>void action(async()=>{await api.revokeCaptureDevice(d.id);setDevices((await api.getCaptureDevices()).devices);}))}</View>)}
          <Text style={[styles.label,{color:c.textPrimary}]}>Mac name</Text><TextInput accessibilityLabel="Companion Mac name" value={deviceName} onChangeText={setDeviceName} style={[styles.input,{borderColor:c.border,color:c.textPrimary}]}/>
          {!credential?button('Create companion credential',()=>void action(async()=>{const device=await api.createCaptureDevice(deviceName);setCredential(JSON.stringify({url:OPENCHAT_URL,token:device.token},null,2));setDevices((await api.getCaptureDevices()).devices);})):<><Text style={[styles.explanation,{color:c.textMetadata}]}>Save this private configuration on your Mac at ~/.config/openchat/companion.json with permissions 600. The credential is shown once.</Text><Text selectable style={[styles.code,{color:c.textPrimary,backgroundColor:c.surfaceElevated}]}>{credential}</Text></>}
          <Text style={[styles.explanation,{color:c.textMetadata}]}>CLI: python3 scripts/message-companion/companion.py watch. Messages access requires macOS Full Disk Access. WhatsApp connection is planned.</Text>
        </>}
        {!!error&&<Text accessibilityRole="alert" style={{color:c.danger}}>{error}</Text>}
        {button('Done',()=>{setSelected(null);setSetup(false);setAdding(false);setCredential('');})}
      </ScrollView></View></View>
    </Modal>
  </View>;
}
const styles=StyleSheet.create({
  root:{flex:1},doors:{flexDirection:'row',flexWrap:'wrap',gap:8,padding:12,borderBottomWidth:1},body:{flex:1},wide:{flexDirection:'row'},sidebar:{width:232,borderRightWidth:1,padding:12},threadStrip:{maxHeight:100,borderBottomWidth:1},threadList:{gap:8},horizontal:{padding:12,gap:8,alignItems:'center'},thread:{padding:12,borderWidth:1,borderRadius:8,maxWidth:260,minWidth:144,minHeight:64},content:{flex:1,padding:16,minWidth:0},heading:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap'},title:{fontSize:24,fontWeight:'600',flexShrink:1},subtitle:{fontSize:18,fontWeight:'600'},meta:{fontSize:12,lineHeight:18},input:{borderWidth:1,borderRadius:8,minHeight:44,padding:12,marginVertical:12,fontSize:16},entries:{paddingBottom:24,gap:12},entry:{padding:16,borderWidth:1,borderRadius:8,gap:8},captureText:{fontSize:16,lineHeight:24,marginVertical:8},tags:{flexDirection:'row',flexWrap:'wrap',gap:8},tag:{padding:8,minHeight:44,justifyContent:'center',borderRadius:6},row:{flexDirection:'row',gap:8,flexWrap:'wrap'},button:{minHeight:44,paddingHorizontal:12,paddingVertical:10,borderWidth:1,borderRadius:8,justifyContent:'center'},empty:{paddingVertical:32},explanation:{fontSize:14,lineHeight:22,marginVertical:12},footer:{fontSize:12,lineHeight:18,paddingVertical:16},error:{gap:8,paddingBottom:12},shade:{flex:1,backgroundColor:'rgba(0,0,0,0.4)',alignItems:'center',justifyContent:'center',padding:20},modal:{width:'100%',maxWidth:600,maxHeight:'90%',padding:24,borderRadius:12,borderWidth:1},label:{marginTop:16,fontWeight:'600'},code:{fontSize:12,lineHeight:20,padding:12},device:{gap:8,marginVertical:12},
});
