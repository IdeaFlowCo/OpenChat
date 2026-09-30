import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ScanQrScreen} from '../../src/screens/ScanQrScreen.web';
import {CardEntryScreen} from '../../src/screens/CardEntryScreen';
import QRCode from 'qrcode';
const w = window as any;
w.events=[]; w.cameraMode='denied'; w.token='AbCdEfGhIjKlMnOpQrStUvWx';
w.card={name:'Alex Rivera',isBot:false,headline:'Building thoughtful communities',avatarUrl:null,status:null,linkedIn:null,x:null,link:null};
w.useTheme=()=>({scheme:'light'});
w.route={params:{token:w.token}};
w.api={getPublicCard:async(t)=>{w.events.push(['getCard',t]);return w.card},getCardFriendStatus:async()=>({state:'none',userId:'alex'}),requestCardFriend:async(t)=>{w.events.push(['friendRequest',t]);return {state:'outgoing',userId:'alex'}},changeFriend:async()=>{throw Error('unexpected')}};
w.open=(url)=>{w.events.push(['saveContact',url]);return null};
Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{
 w.events.push(['cameraRequested']);
 if(w.cameraMode==='denied')throw new DOMException('Permission denied','NotAllowedError');
 const canvas=document.createElement('canvas');
 await QRCode.toCanvas(canvas,w.cameraValue||`https://chat.globalbr.ai/c/${w.token}`,{width:480,margin:4});
 const stream=canvas.captureStream(10);const track=stream.getVideoTracks()[0];const stop=track.stop.bind(track);track.stop=()=>{w.events.push(['trackStopped']);stop()};
 w.stream=stream; return stream;
}}});
function App(){const [screen,setScreen]=useState('scan');w.reset=()=>{w.events=[];setScreen('blank');setTimeout(()=>setScreen('scan'),0)};w.nav={replace:(name,params)=>{w.events.push(['navigate',name,params]);w.route={params};setScreen('card')},canGoBack:()=>true,goBack:()=>setScreen('blank')};w.leave=()=>setScreen('blank');return screen==='scan'?<ScanQrScreen/>:screen==='card'?<CardEntryScreen/>:<div>Scanner closed</div>}
createRoot(document.getElementById('root')!).render(<App/>);
