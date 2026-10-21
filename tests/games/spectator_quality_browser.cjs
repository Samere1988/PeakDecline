/* Measure the actual media transport independently of any engine's native FPS.
 * Uses real authenticated rooms, signaling and shared presentation code with a
 * deterministic 1920x1080 moving test scene and a stereo tone before local mute. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const base=process.env.LOBBY_TEST_URL||'http://127.0.0.1:8079';
assert.equal(new URL(base).hostname,'127.0.0.1');
const out=process.env.QUALITY_RESULTS||'.tmp/spectator-quality';fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_PATH||path.join(os.homedir(),'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),args:['--autoplay-policy=no-user-gesture-required','--enable-unsafe-swiftshader']});
 const contexts=[],pages=[],errors=[],report={};
 try{
  for(let i=0;i<3;i++){
   const context=await browser.newContext({viewport:{width:1280,height:900}});contexts.push(context);
   const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/test-login/quality-'+Date.now()+'-'+i);
  }
  const [host,watcher,second]=pages;
  await host.evaluate(()=>{
   let surface,mix,audio,animation,running=false,frames=0;
   PeakNet.adapters.set('sm64',{
    present(){},hostChanged(){},spectatorSurface:()=>surface,spectatorAudioSource:()=>mix,
    launch({session}){
     surface=document.createElement('canvas');surface.width=1920;surface.height=1080;
     surface.style.width='960px';document.body.append(surface);const ctx=surface.getContext('2d');
     audio=new AudioContext();mix=audio.createGain();const muted=audio.createGain();muted.gain.value=0;mix.connect(muted);muted.connect(audio.destination);
     const tone=audio.createOscillator();tone.frequency.value=440;tone.connect(mix);tone.start();
     function draw(now){
      if(!running)return;
      ctx.fillStyle='#123b66';ctx.fillRect(0,0,1920,1080);
      for(let y=0;y<1080;y+=60){ctx.fillStyle=`hsl(${(now/40+y)%360} 70% 55%)`;ctx.fillRect((now/3+y)%1920,y,300,40);}
      ctx.fillStyle='white';ctx.font='80px sans-serif';ctx.fillText('1080p / 60 fps • '+frames,100,150);
      session.frame=++frames;animation=requestAnimationFrame(draw);
     }
     session.bind(()=>{running=true;audio.resume();animation=requestAnimationFrame(draw);});
    },
    async stop(){running=false;cancelAnimationFrame(animation);surface?.remove();await audio?.close();}
   });
  });
  await host.locator('#retro-open-create').click();await host.locator('#retro-game-select').selectOption('sm64');
  await host.locator('#retro-room-name').fill('1080p60 transport');await host.locator('#retro-room-create').click();
  await host.locator('#retro-lobby').waitFor();const invite=await host.locator('#retro-invite').inputValue();
  await watcher.goto(invite);await watcher.locator('#retro-lobby').waitFor();
  await host.locator('#retro-ready').click();await host.locator('#retro-start-race').click();
  const live=page=>page.waitForFunction(()=>window.retroNetplay?.streaming,null,{timeout:30000});
  await live(watcher);await watcher.locator('#retro-spectator-sound').click();
  const stats=page=>page.evaluate(async()=>{
   const reports=[...(await retroNetplay.receiver.peer.pc.getStats()).values()];
   return reports.filter(s=>s.type==='inbound-rtp').map(s=>({kind:s.kind,width:s.frameWidth,height:s.frameHeight,fps:s.framesPerSecond,frames:s.framesDecoded,bytes:s.bytesReceived,lost:s.packetsLost,energy:s.totalAudioEnergy}));
  });
  await watcher.waitForTimeout(8000);report.first=await stats(watcher);
  report.sender=await host.evaluate(async()=>{
   const publisher=retroNetplay.spectatorPublisher,peer=[...publisher.peers.values()][0];
   return {target:PeakNet.SpectatorStream.target,track:publisher.capture.getVideoTracks()[0].getSettings(),parameters:peer.video.getParameters(),stats:[...(await peer.pc.getStats()).values()].filter(s=>s.type==='outbound-rtp').map(s=>({kind:s.kind,fps:s.framesPerSecond,width:s.frameWidth,height:s.frameHeight,limitation:s.qualityLimitationReason,frames:s.framesEncoded}))};
  });
  console.log('QUALITY',JSON.stringify({receiver:report.first,sender:report.sender.stats}));
  let video=report.first.find(s=>s.kind==='video');assert.equal(video.width,1920);assert.equal(video.height,1080);assert.ok(video.fps>=55,'1080p60 stream should deliver at least 55 fps on the local fixture');
  assert.ok(report.first.find(s=>s.kind==='audio').energy>0,'Muting the host must not mute the spectator mix');
  // A second late viewer must not disturb the established peer.
  await second.goto(invite);await live(second);await second.waitForTimeout(4000);
  report.second=await stats(second);assert.ok((await stats(watcher)).find(s=>s.kind==='video').fps>=50);
  for(let i=0;i<2;i++){
   await watcher.locator('#retro-return').click();await watcher.locator('#retro-room-browser').waitFor();
   await watcher.goto(invite);await live(watcher);
  }
  report.rejoins=2;
  // Force transport failure; fallback must resume and ICE must reconnect.
  await watcher.evaluate(()=>retroNetplay.receiver.peer.pc.close());
  await watcher.waitForFunction(()=>!retroNetplay.streaming,null,{timeout:8000});
  const before=await watcher.evaluate(()=>retroNetplay.frame);
  await watcher.waitForFunction(before=>retroNetplay.frame>before+10,before,{timeout:10000});
  report.fallback=true;await live(watcher);report.recovered=true;
  // Removing every viewer releases the source tracks and per-viewer encoders.
  for(const page of [watcher,second])await page.locator('#retro-return').click();
  await host.waitForFunction(()=>retroNetplay.spectatorPublisher.peers.size===0&&!retroNetplay.spectatorPublisher.capture);
  // No WebRTC support still gets the image relay and can rejoin.
  await second.evaluate(()=>{window.RTCPeerConnection=undefined;});
  const room=second.locator('#retro-room-browser article').filter({hasText:'1080p60 transport'});
  await room.getByRole('button',{name:'Spectate',exact:true}).click();
  await second.waitForFunction(()=>window.retroNetplay?.running&&retroNetplay.frame>30,null,{timeout:15000});
  report.noRTC=await second.evaluate(()=>({streaming:!!retroNetplay.streaming,width:document.getElementById('retro-spectator-canvas').width}));
  assert.equal(report.noRTC.streaming,false);assert.equal(report.noRTC.width,1280);
  await host.locator('#retro-close-game').click();for(const page of [host,second])await page.locator('#retro-lobby').waitFor();
  assert.deepEqual(errors,[]);report.status='passed';console.log('PASS spectator quality and recovery');
 }catch(error){report.status='failed';report.error=error.stack;report.errors=errors;throw error;}
 finally{fs.writeFileSync(path.join(out,'quality-results.json'),JSON.stringify(report,null,2));for(const c of contexts)await c.close();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
