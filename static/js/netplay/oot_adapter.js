(() => {
 'use strict';
 const area=document.getElementById('oot-play-area');if(!area)return;
 const target=area.querySelector('[data-game-frame]'), status=area.querySelector('[data-oot-status]');
 const volume=document.getElementById('oot-volume');
 const controller=RetroControllers.create('oot'),controls=document.getElementById('oot-controller-controls');
 for(const part of ['panel','tools','bindings'])controls.querySelector('.oot-controller-'+part)?.classList.add('mk64-controller-'+part);
 area.querySelector('[data-import-save-button]').addEventListener('click',()=>area.querySelector('[data-import-save]').click());
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
  window.peakOotBridge=null;area.hidden=true;return saving;
 }
 area.querySelector('[data-export-save]').addEventListener('click',async()=>{
  const output=area.querySelector('[data-save-status]');
  try{const data=await frame?.contentWindow.peakExportSave?.();if(!data)throw new Error('Wait for the game to load.');
   const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'}));
   const link=document.createElement('a');link.href=url;link.download='ocarina-of-time-save.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
   output.textContent='Save exported.';
  }catch(error){output.textContent=error.message;}
 });
 area.querySelector('[data-import-save]').addEventListener('change',async event=>{
  const file=event.target.files[0],output=area.querySelector('[data-save-status]');event.target.value='';if(!file)return;
  try{if(file.size>4*1024*1024)throw new Error('Save file is too large.');
   if(!frame?.contentWindow.peakImportSave)throw new Error('Wait for the game to load.');
   await frame.contentWindow.peakImportSave(JSON.parse(await file.text()));output.textContent='Save imported. Restarting the game…';
  }catch(error){output.textContent=error.message;}
 });
 PeakNet.adapters.set('oot',{
  present({name,spectator}){area.querySelector('[data-game-title]').textContent='The Legend of Zelda: Ocarina of Time';area.querySelector('[data-player-tools]').hidden=spectator;},
  lobby({role}){controls.hidden=role==='spectator';document.getElementById('retro-controller-setup')?.append(controls);},
  hostChanged(){},stop,
  spectatorSurface:()=>frame?.contentDocument?.querySelector('canvas'),
  spectatorAudioSource:()=>frame?.contentWindow.peakSpectatorAudioSource?.(),
  async launch({session,slot}){
   await stop();area.querySelector('[data-player-tools]').append(controls);controls.hidden=session.spectator;area.hidden=false;const current=generation;target.replaceChildren();
   if(session.spectator){
    canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
    canvas.style.cssText='width:100%;height:100%;object-fit:contain;background:#080503';canvas.setAttribute('aria-label','Live Ocarina of Time spectator view');target.append(canvas);
    const ctx=canvas.getContext('2d');status.textContent='Watching. Enable sound to hear the game.';
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
   status.textContent='Loading Ocarina of Time…';
   await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Ocarina of Time took too long to load.')),295000);
    window.peakOotBridge={slot,readPad:()=>controller.read(),saveStatus:message=>{area.querySelector('[data-save-status]').textContent=message;},
     tick:frame=>{session.frame=frame;}, watching:()=>session.hasSpectators,
     running:()=>session.running&&!session.failed&&current===generation,
     broadcast:(kind,payload)=>{if(current===generation)session.broadcast(kind,payload);},
     failed:message=>{clearTimeout(timeout);if(current===generation){reject(new Error(message));session.fail(message);}},
     ready:start=>{clearTimeout(timeout);if(current!==generation)return;
      sound();status.textContent='';
      session.bind(start);if(session.running)start();resolve();}
    };
    frame=document.createElement('iframe');frame.title='The Legend of Zelda: Ocarina of Time';frame.allow='autoplay; fullscreen; gamepad';
    frame.src=area.dataset.runtimeUrl;target.append(frame);
   });
  }
 });
})();
