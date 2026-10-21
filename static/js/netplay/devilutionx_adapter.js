(() => {
 'use strict';
 const area=document.getElementById('devilutionx-play-area');if(!area)return;
 const target=area.querySelector('[data-game-frame]'), status=area.querySelector('[data-diablo-status]');
 const volume=document.getElementById('devilutionx-volume');
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
  window.peakDiabloBridge=null;area.hidden=true;return saving;
 }
 PeakNet.adapters.set('devilutionx',{
  present({name,spectator}){area.querySelector('[data-game-title]').textContent=name+' · '+(spectator?'Watching Diablo':'Diablo');},
  hostChanged(){},stop,
  spectatorSurface:()=>frame?.contentDocument?.querySelector('canvas'),
  spectatorAudioSource:()=>frame?.contentWindow.peakSpectatorAudioSource?.(),
  async launch({session,slot}){
   await stop();area.hidden=false;const current=generation;target.replaceChildren();
   if(session.spectator){
    canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
    canvas.style.cssText='width:100%;height:100%;object-fit:contain;background:#080503';canvas.setAttribute('aria-label','Live Diablo spectator view');target.append(canvas);
    const ctx=canvas.getContext('2d');status.textContent='Watching the first player’s screen. Enable sound to hear the game.';
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
   status.textContent='Loading full Diablo data. The archive is about 494 MB.';
   await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Diablo took too long to load.')),295000);
    window.peakDiabloBridge={saveStatus:message=>{status.textContent=message;},slot,queue:session.queue,send:packet=>session.send(packet),
     tick:frame=>{session.frame=frame;}, watching:()=>session.hasSpectators,
     running:()=>session.running&&!session.failed&&current===generation,
     broadcast:(kind,payload)=>{if(current===generation)session.broadcast(kind,payload);},
     failed:message=>{clearTimeout(timeout);if(current===generation){reject(new Error(message));session.fail(message);}},
     ready:start=>{clearTimeout(timeout);if(current!==generation)return;
      sound();status.textContent='Select or create your hero. The room connects you automatically.';
      session.bind(start);resolve();}
    };
    frame=document.createElement('iframe');frame.title='Diablo · DevilutionX';frame.allow='autoplay; fullscreen; gamepad';
    frame.src=area.dataset.runtimeUrl;target.append(frame);
   });
  }
 });
})();
