(()=>{
 'use strict';
 const area=document.getElementById('perfectdark-play-area');if(!area)return;
 const actions = PeakNet.perfectDarkActions;
 const labels = {fire:'Fire', aim:'Aim', reload:'Reload', use:'Use / confirm', crouch:'Crouch',
  nextWeapon:'Next weapon', previousWeapon:'Previous weapon', start:'Start / pause', cancel:'Back', secondary:'Secondary fire'};
 const controller = RetroControllers.create('perfectdark', mk64Gamepad.createLayout({
  name: 'Perfect Dark',
  actions: Object.entries(actions).filter(([key])=>key!=='accept').map(([key,a])=>[key,labels[key],a.bit]),
  sticks: [{key:'stickX',label:'Move the left stick right'},{key:'stickY',label:'Move the left stick up'},
   {key:'stickLookX',label:'Move the aiming stick right'},{key:'stickLookY',label:'Move the aiming stick down'}],
  standardProfile: ()=>({version:1,deadzone:0.18,
   bindings:Object.fromEntries(Object.entries(actions).filter(([key])=>key!=='accept').map(([key,a])=>[key,{type:'button',indices:[a.button]}])),
   stickX:{index:0,direction:1,neutral:0},stickY:{index:1,direction:-1,neutral:0},
   stickLookX:{index:2,direction:1,neutral:0},stickLookY:{index:3,direction:1,neutral:0}})
 }), 'perfectdark-gamepad-profiles-v1');
 document.getElementById('perfectdark-controller-step').textContent = 'Standard gamepads use the left stick to move and the right stick to aim. Select any control to change its mapping, or choose Set up all controls for guided setup. Use / confirm also confirms menu selections.';
 let frame,input,engine,timer,visibilityHandler,generation=0,replaying=true;
 const volume=area.querySelector('[data-game-volume]');
 function sound(){const output=area.querySelector('[data-game-volume-value]');if(output)output.textContent=volume.value+'%';frame?.contentWindow.setPeakGameVolume?.(replaying?0:Number(volume.value)/100);}
 volume.addEventListener('input',sound);
 const fs=GameFullscreen.create({area:area.querySelector('.retro-frame-shell'),button:area.querySelector('[data-game-fullscreen]'),
  status:area.querySelector('[data-fullscreen-status]'),focusGame:()=>frame?.contentDocument.querySelector('canvas')?.focus()});
 function stop(){controller.cancel();generation++;if(visibilityHandler)document.removeEventListener('visibilitychange',visibilityHandler);visibilityHandler=null;cancelAnimationFrame(timer);input?.destroy();input=null;engine=null;const old=frame;frame=null;area.hidden=true;window.peakPerfectDarkBridge=null;return old?Promise.resolve(old.contentWindow.peakShutdown?.()).finally(()=>{old.contentWindow.Module?.pdAudioContext?.close().catch(()=>{});old.remove();}):Promise.resolve();}
 PeakNet.adapters.set('perfectdark',{
  present({name,spectator}){area.querySelector('[data-game-title]').textContent=name+' · '+(spectator?'Watching Perfect Dark':'Perfect Dark');},
  hostChanged(){},stop,
  async launch({session,players,seed,slot,initialSave}){
   await stop();area.hidden=false;const current=generation;
   await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Perfect Dark took too long to load.')),120000);
    window.peakPerfectDarkBridge={players,seed,initialSave,saveOwner:!session.spectator&&slot===0,
     saveStatus:message=>{area.querySelector('[data-save-status]').textContent=message;},
     failed:message=>{clearTimeout(timeout);if(current===generation)reject(new Error(message));},
     ready:(runtime,canvas)=>{
      clearTimeout(timeout);if(current!==generation)return;
      engine=runtime;replaying=true;
      if(!session.spectator)input=new PeakNet.FpsInput({element:canvas,tickRate:60,actions:PeakNet.perfectDarkActions,controllerInput:()=>{
       const state=controller.read();
       return {buttons:state.buttons | (state.buttons & actions.use.bit ? actions.accept.bit : 0),
        moveX:state.x/80,moveY:-state.y/80,lookX:(state.lookX||0)/80,lookY:(state.lookY||0)/80};
      }});
      canvas.addEventListener('click',()=>frame.contentWindow.resumePeakGameAudio());
      const binding={sampleInput:()=>input?.sampleInput()||{buttons:0,moveX:0,moveY:0,lookX:0,lookY:0},
       step:commands=>{engine.step(commands);engine.drainEvents();},
       setReplaying:value=>{replaying=value;engine.setPresentation(!value);frame.contentWindow.setPeakReplayAudio(value);sound();},
       hash:()=>{const m=engine.module;const value=JSON.stringify({state:engine.captureComponents(),flow:engine.observeFlow(),random:Array.from({length:4},(_,n)=>m._peakPdRandomWord(n))});let h=2166136261;for(let n=0;n<value.length;n++)h=Math.imul(h^value.charCodeAt(n),16777619)>>>0;return h;}
      };
      // Expose the same native adapter boundary used by automated game tests.
      session.nativeEngine=engine;
      visibilityHandler=()=>{input?.reset();session.setBackground(document.hidden);};
      document.addEventListener('visibilitychange',visibilityHandler);visibilityHandler();
      session.bind(binding);
      function pump(){
       if(current!==generation||session.failed)return;
       const deadline=performance.now()+10;
       while(performance.now()<deadline&&session.advance()){}
       const status=document.getElementById('retro-runtime-status');
       if(!session.transportSuspended&&session.running)status.textContent=session.live&&!session.replaying?
        (session.spectator?'Watching the game.':'Connected. Use the original game menus.'):'Catching up with the game…';
       timer=requestAnimationFrame(pump);
      }
      pump();resolve();
     }
    };
    frame=document.createElement('iframe');frame.title='Perfect Dark';frame.allow='autoplay; fullscreen; gamepad';
    frame.src=area.dataset.runtimeUrl;area.querySelector('[data-game-frame]').replaceChildren(frame);
   });
  }
 });
})();
