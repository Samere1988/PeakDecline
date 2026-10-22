/* Test fixture only; never included in production templates. */
(()=>{
 const panel=document.createElement('details');panel.open=true;panel.id='authority-test';
 panel.innerHTML='<summary>Authority test controls</summary><div id="authority-buttons"></div><pre id="authority-observation"></pre>';
 document.body.append(panel);
 const canvas=()=>document.getElementById('mk64-canvas');
 function key(code,ms){const c=canvas();c.focus();c.dispatchEvent(new KeyboardEvent('keydown',{code,bubbles:true}));setTimeout(()=>window.dispatchEvent(new KeyboardEvent('keyup',{code,bubbles:true})),ms);}
 for(const [name,code,ms] of [['Press Start','Enter',150],['Press A','KeyX',150],['Press B','KeyC',150],['Steer right','ArrowRight',150],['Steer left','ArrowLeft',150],['Drive 10 seconds','KeyX',10000],['Use item','KeyZ',150]]){
  const b=document.createElement('button');b.textContent=name;b.onclick=()=>key(code,ms);panel.querySelector('div').append(b);
 }
 const menu=document.createElement('button');menu.textContent='Auto-select GP';menu.onclick=()=>{
  const timer=setInterval(()=>{const s=window.retroNetplay,m=window.mk64;if(!s?.sim||s.failed){clearInterval(timer);return;}
   const page=m._web_menu(),stage=m._web_main_menu_selection();
   if(page===14&&m._web_state()===4){clearInterval(timer);return;}
   if(page===12){if(!m._web_character_selected(s.slot))key('KeyX',120);else if(s.slot===0)key('KeyX',120);}
   else if(s.slot===0){if(page===10)key('Enter',120);
    else if(page===11&&stage===3&&m._web_selected_players()!==s.players)key('ArrowRight',120);
    else if(page===11||page===13)key('KeyX',120);}
  },650);
 };panel.querySelector('div').append(menu);
 const network=document.createElement('button');network.textContent='Simulate 200ms RTT and input loss';network.onclick=()=>{
  const s=window.retroNetplay;if(!s?.ready||s.testNetwork)return;s.testNetwork=true;
  const receive=s.receive;s.socket.off('kart_snapshot',receive);s.receive=p=>setTimeout(()=>receive(p),100);
  s.socket.on('kart_snapshot',s.receive);
  const latency=s.latency.bind(s);s.latency=ms=>latency(Math.max(200,ms));s.latency(200);
  const emit=s.socket.emit.bind(s.socket);let sent=0;
  s.socket.emit=(name,...args)=>{
   if(name!=='kart_input')return emit(name,...args);
   if(++sent%10)setTimeout(()=>emit(name,...args),80+(sent%5)*10);
  };
 };panel.querySelector('div').append(network);
 const fault=document.createElement('button');fault.textContent='Inject position mismatch';fault.onclick=()=>{
  const s=window.retroNetplay;if(!s?.sim)return;
  const r=s.manifest.regions.find(r=>r.symbol==='gPlayers'),v=new DataView(s.adapter.module.HEAPU8.buffer);
  v.setFloat32(r.address+0x14,v.getFloat32(r.address+0x14,true)+40,true);
 };panel.querySelector('div').append(fault);
 setInterval(()=>{const s=window.retroNetplay,m=window.mk64;if(!s?.sim)return;
  if(!m.audioObserved){m.audioObserved=true;m.audioEnqueues=0;const enqueue=m.mk64Audio.enqueue;m.mk64Audio.enqueue=(...args)=>{m.audioEnqueues++;return enqueue(...args);};}
  document.getElementById('authority-observation').textContent=JSON.stringify({frame:s.frame,authority:s.latest?.frame,slot:s.slot,
   menu:m._web_menu(),mainMenu:m._web_main_menu_selection(),players:m._web_selected_players(),game:m._web_state(),race:m._web_race_state(),
   characters:[0,1,2,3].map(i=>m._web_character_selected(i)),position:[0,1,2].map(i=>m._web_player_position(s.slot||0,i)),
   simulatedNetwork:!!s.testNetwork,audioEnqueues:m.audioEnqueues,hdApplied:m.mk64HD?.stats.applied,corrections:s.client.metrics.corrections,replayed:s.client.metrics.replayed,checkpointMs:s.checkpointMs,failed:s.failed,ready:s.ready},null,2);
 },250);
})();
