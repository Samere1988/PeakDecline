const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.WATCH_PLAYWRIGHT||'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.WATCH_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try{
  const page=await browser.newPage();
  await page.setContent('<video id="video-player"></video>'+['current-channel-logo','current-channel-name','current-status-text','search-box','channel-list','favorites-list','chat-input','chat-messages','send-btn','users-list','user-count'].map(id=>`<div id="${id}"></div>`).join(''));
  await page.evaluate(()=>{window.handlers={};window.io=()=>({on:(e,f)=>handlers[e]=f,emit(){}});});
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../../static/js/tv_player.js'),'utf8')});
  const result=await page.evaluate(()=>{
   setupChat();const payload='<img src=x onerror="window.injected=true">';
   handlers.chat_message({user:payload,text:payload});handlers.live_tv_users_update([payload]);
   channelCache=[{id:1,name:payload,logo:'x" onerror="window.injected=true',Favorites:true}];renderChannels();
   return {injected:!!window.injected,chatImages:document.querySelectorAll('#chat-messages img, #users-list img').length,
    literal:document.querySelector('#chat-messages').textContent.includes(payload),
    handlers:document.querySelectorAll('[onerror]').length};
  });
  assert.deepEqual(result,{injected:false,chatImages:0,literal:true,handlers:0});
  console.log('PASS real-browser chat, username, channel name and logo injection regression');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
