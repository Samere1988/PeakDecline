(() => {
 'use strict';
 const area=document.getElementById('cmr2-play-area');if(!area)return;
 const diagnostics=new URLSearchParams(location.search).get('cmr2-diagnostics')==='1';
 const target=area.querySelector('[data-game-frame]'), status=area.querySelector('[data-engine-status]');
 const volume=document.getElementById('cmr2-volume');
 const controls=area.querySelector('[data-controller-controls]');
 const layout=mk64Gamepad.createLayout({name:'Colin McRae Rally 2.0',actions:[['a','Accelerate',0x8000],['b','Brake',0x4000],['z','Handbrake',0x2000],['start','Confirm / pause',0x1000],['cUp','Back',8]],standardProfile:()=>({version:1,deadzone:.18,bindings:{a:{type:'button',indices:[7]},b:{type:'button',indices:[6]},z:{type:'button',indices:[0]},start:{type:'button',indices:[9]},cUp:{type:'button',indices:[1]}},stickX:{index:0,direction:1,neutral:0},stickY:{index:1,direction:-1,neutral:0}})});
 const controller=RetroControllers.create('cmr2',layout,'cmr2-gamepad-profiles-v1');
 controls.querySelector('p:last-child').textContent='Use the left stick to steer, the right trigger to accelerate, the left trigger to brake and A for the handbrake. Start confirms; B goes back. Select a control above to change its mapping.';
 let requestRestart;
 const restart=area.querySelector('[data-game-restart]');restart.addEventListener('click',()=>requestRestart?.());
 let frame, canvas, audio, gain, nextAudio=0, generation=0, decoding=false;
 function sound(){area.querySelector('output').value=volume.value+'%';if(gain)gain.gain.value=volume.value/100;frame?.contentWindow.setPeakGameVolume?.(volume.value/100);}
 volume.addEventListener('input',sound);
 area.querySelector('[data-enable-audio]').addEventListener('click',()=>{
  if(canvas && !audio){audio=new AudioContext();gain=audio.createGain();gain.connect(audio.destination);sound();}
  audio?.resume();frame?.contentWindow.resumePeakGameAudio?.();
 });
 GameFullscreen.create({area:area.querySelector('.retro-frame-shell'),button:area.querySelector('[data-game-fullscreen]'),
  status:area.querySelector('[data-fullscreen-status]'),focusGame:()=>frame?.contentDocument.getElementById('canvas')?.focus()});
 function stop(){
  generation++;const old=frame;frame=null;
  const saving=old?Promise.resolve(old.contentWindow.peakShutdown?.()).finally(()=>old.remove()):Promise.resolve();
  audio?.close().catch(()=>{});audio=gain=null;canvas=null;nextAudio=0;decoding=false;
  window.peakCMR2Bridge=null;area.hidden=true;return saving;
 }
 PeakNet.adapters.set('cmr2',{
  present({name,spectator,requestRestart:restartRoom}){requestRestart=restartRoom;area.querySelector('[data-game-title]').textContent='Colin McRae Rally 2.0';},
  lobby({role}){controls.hidden=role==='spectator';document.getElementById('retro-controller-setup')?.append(controls);},hostChanged(isHost){restart.hidden=!isHost;},stop,
  spectatorSurface:()=>frame?.contentDocument?.querySelector('canvas'),
  spectatorAudioSource:()=>frame?.contentWindow.peakSpectatorAudioSource?.(),
  async launch({session,slot,canRestart}){
   restart.hidden=!canRestart;
   await stop();area.querySelector('[data-player-tools]').append(controls);area.querySelector('[data-player-tools]').hidden=session.spectator;area.hidden=false;const current=generation;target.replaceChildren();
   if(session.spectator){
    canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
    canvas.style.cssText='width:100%;height:100%;object-fit:contain;background:#080503';canvas.setAttribute('aria-label','Live Colin McRae Rally 2.0 spectator view');target.append(canvas);
    const ctx=canvas.getContext('2d');status.textContent='Watching the room coordinator’s screen. Enable sound to hear the game.';
    session.bind(()=>{},async event=>{
     if(current!==generation)return;
     if(event.kind==='video'){
      if(decoding)return;decoding=true;
      try{const image=await createImageBitmap(new Blob([event.payload],{type:'image/webp'}));
       if(current===generation){ctx.drawImage(image,0,0,640,480);session.frame++;}image.close();
      }catch{}finally{if(current===generation)decoding=false;}
     }else if(event.kind==='audio'&&audio?.state==='running'){
      const pcm=new Int16Array(event.payload), buffer=audio.createBuffer(1,pcm.length,16000), output=buffer.getChannelData(0);
      for(let i=0;i<pcm.length;i++)output[i]=pcm[i]/32768;
      const now=audio.currentTime;if(nextAudio<now||nextAudio>now+.5)nextAudio=now+.08;
      const source=audio.createBufferSource();source.buffer=buffer;source.connect(gain);source.start(nextAudio);nextAudio+=buffer.duration;
     }
    });return;
   }
   status.textContent='Loading Colin McRae Rally 2.0…';
   // Keep detailed timing opt-in; the normal room already reports average FPS.
   if(diagnostics)session.frameTiming=new PeakNet.FrameTiming();
   await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Colin McRae Rally 2.0 took too long to load.')),295000);
    window.peakCMR2Bridge={session,readPad:()=>controller.read(),status:message=>{status.textContent=message;},saveStatus:message=>{area.querySelector('[data-save-status]').textContent=message;},slot,
     tick:frame=>{session.frame=frame;}, watching:()=>session.canBroadcast(),
     profileFrame:session.frameTiming?((phase,active)=>session.frameTiming.mark(phase,active)):undefined,
     running:()=>session.running&&!session.failed&&current===generation,
     broadcast:(kind,payload)=>{if(current===generation)session.broadcast(kind,payload);},
     failed:message=>{clearTimeout(timeout);if(current===generation){reject(new Error(message));session.fail(message);}},
     ready:start=>{clearTimeout(timeout);if(current!==generation)return;
      sound();status.textContent='';
      session.bind(start);if(session.running)start();resolve();}
    };
    frame=document.createElement('iframe');frame.title='Colin McRae Rally 2.0';frame.allow='autoplay; fullscreen; gamepad';
    frame.src=area.dataset.runtimeUrl;target.append(frame);
   });
  }
 });
})();
