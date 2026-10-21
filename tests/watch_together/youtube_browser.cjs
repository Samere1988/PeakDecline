// Real browser decode/controls using a prepared local YouTube smoke fixture.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.WATCH_PLAYWRIGHT || 'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '../..');
const template = fs.readFileSync(path.join(root, 'templates/room.html'), 'utf8');
const content = template.split('{% block content %}')[1].split('{% endblock %}')[0]
    .replace(/<script[\s\S]*?<\/script>/g, '').replace(/\{\{[\s\S]*?\}\}/g, '').replace(/\{%[\s\S]*?%\}/g, '');
let status = {state:'preparing',message:'Preparing shared playback',percent:42,eta_seconds:80,elapsed_seconds:30};
let manifestLimit = null, manifestComplete = true;
const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/') {
        res.setHeader('Content-Type', 'text/html');
        return res.end(`<link rel="stylesheet" href="/static/css/room.css"><link rel="stylesheet" href="/static/css/player_controls.css">${content}<script>
        const app=document.getElementById('room-app');
        Object.assign(app.dataset,{roomId:'1',isHost:'true',hostUsername:'Host',username:'Host'});
        window.handlers={}; window.io=()=>({connected:true,on:(e,fn)=>handlers[e]=fn,emit(){},io:{on(){}}});
        </script><script src="/hls.js"></script><script src="/static/js/room_player.js"></script>`);
    }
    if (url.endsWith('youtube-status')) {res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify(status));}
    const file = url === '/hls.js' ? path.join(__dirname, 'fixtures/hls.min.js')
        : url.startsWith('/media/') ? path.join(process.env.WATCH_YOUTUBE_FIXTURE || path.join(root, '.tmp/youtube-smoke'), path.basename(url))
        : path.join(root, url);
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const ext = path.extname(file);
    res.setHeader('Content-Type', {'.m3u8':'application/vnd.apple.mpegurl','.ts':'video/mp2t','.js':'text/javascript','.css':'text/css'}[ext] || 'application/octet-stream');
    if (ext === '.m3u8') {
        const text = fs.readFileSync(file, 'utf8');
        const parts = text.split('#EXTINF:');
        const header = parts.shift().replace('PLAYLIST-TYPE:VOD','PLAYLIST-TYPE:EVENT');
        const segments = (manifestLimit === null ? parts : parts.slice(0,manifestLimit))
            .map(part=>'#EXTINF:'+part.replace('#EXT-X-ENDLIST','')).join('');
        res.setHeader('Cache-Control','no-store');
        return res.end(header+segments+(manifestComplete?'#EXT-X-ENDLIST\n':''));
    }
    fs.createReadStream(file).pipe(res);
});
(async () => {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser = await chromium.launch({headless:true, executablePath:process.env.WATCH_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    try {
        const page = await browser.newPage();
        const errors=[]; page.on('pageerror', error=>errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.locator('#btn-open-search').click();
        for (const width of [390,1366]) {
            await page.setViewportSize({width,height:900});
            assert.equal(await page.locator('#youtube-url').isVisible(),true);
            assert.equal(await page.locator('#youtube-form button').isVisible(),true);
            assert.equal(await page.locator('#youtube-progress').evaluate(el=>el.value),42);
            assert.match(await page.locator('#youtube-error').textContent(),/42%.*1:20 remaining/);
        }
        await page.locator('#btn-close-search').click();
        assert.equal(await page.locator('#youtube-room-progress').isVisible(),true);
        status = {state:'preparing',message:'Preparing shared playback',percent:65,stalled:true};
        await page.waitForFunction(()=>document.getElementById('youtube-room-progress').value===65);
        assert.match(await page.locator('#youtube-room-message').textContent(),/No recent progress/);
        status = {state:'error',message:'Video preparation stopped making progress. Please retry.'};
        await page.waitForFunction(()=>document.getElementById('youtube-room-progress').hidden);
        assert.equal(await page.locator('#youtube-form button').isDisabled(),false);
        await page.evaluate(()=>handlers.room_state({room_id:'1',url:'/media/index.m3u8',rating_key:'youtube:jNQXAC9IVRw',title:'YouTube test',revision:1,playback_epoch:'test',media_version:'test',is_playing:false,playback_intent:false,current_time:2}));
        await page.waitForFunction(()=>document.getElementById('video-player').readyState>=3);
        await page.locator('#plex-play-toggle').click();
        await page.waitForFunction(()=>document.getElementById('video-player').currentTime>3);
        await page.locator('#plex-play-toggle').click();
        await page.waitForFunction(()=>document.getElementById('video-player').paused);
        assert.equal(await page.locator('#media-settings-cog').isVisible(),false);
        assert.equal(await page.locator('#plex-player-progress').isDisabled(),false);
        // Grow an EVENT playlist while paused; it must never jump to its prepared edge.
        manifestLimit = 3; manifestComplete = false;
        await page.evaluate(()=>handlers.room_state({room_id:'1',url:'/media/index.m3u8',rating_key:'youtube:jNQXAC9IVRw',title:'Growing test',revision:2,playback_epoch:'test',media_version:'growing',is_playing:false,playback_intent:false,current_time:0,youtube:{prepared_seconds:6,complete:false}}));
        await page.waitForFunction(()=>document.getElementById('video-player').readyState>=3 && document.getElementById('video-player').currentTime<0.1);
        const initialDuration = await page.locator('#video-player').evaluate(el=>el.duration);
        await page.locator('#plex-play-toggle').click();
        await page.waitForFunction(()=>document.getElementById('video-player').currentTime>1);
        await page.locator('#plex-play-toggle').click();
        const pausedPosition = await page.locator('#video-player').evaluate(el=>el.currentTime);
        manifestLimit = 6;
        await page.waitForFunction(initial=>document.getElementById('video-player').duration>initial+1,initialDuration);
        assert.ok(Math.abs(await page.locator('#video-player').evaluate(el=>el.currentTime)-pausedPosition)<0.1);
        assert.equal(await page.locator('#video-player').evaluate(el=>el.paused),true);
        manifestLimit = null; manifestComplete = true;
        await page.locator('#plex-play-toggle').click();
        await page.waitForFunction(initial=>document.getElementById('video-player').currentTime>initial+0.5,initialDuration);
        assert.deepEqual(errors,[]);
        console.log('PASS real YouTube HLS decode, play/pause, progress UI, growing EVENT playlist, paused alignment as segments arrive, and playback beyond initial prepared edge');
    } finally { await browser.close(); server.close(); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
