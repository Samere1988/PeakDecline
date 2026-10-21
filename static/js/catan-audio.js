/* Sound effects are local to the game; never alter any other media player. */
(() => {
    'use strict';
    const active=new Set();
    let muted=false;
    try { muted=localStorage.getItem('catan-sound-muted')==='true'; } catch (_) { /* Storage may be blocked. */ }
    function stop(){active.forEach(audio=>{audio.pause();audio.removeAttribute('src');});active.clear();}
    function play(name){
        if(muted||document.hidden||!/^sfx_[a-z0-9_]+$/.test(name))return;
        // Bound simultaneous effects when several placements happen quickly.
        if(active.size>=3){const oldest=active.values().next().value;oldest.pause();active.delete(oldest);}
        const audio=new Audio(`/static/assets/catan/colonist/sounds/${name}.mp3`);
        audio.volume=0.35;active.add(audio);
        const release=()=>active.delete(audio);
        audio.addEventListener('ended',release,{once:true});audio.addEventListener('error',release,{once:true});
        try { const started=audio.play();if(started)started.catch(release); } catch (_) {release();}
    }
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
    window.addEventListener('pagehide',stop);
    window.CatanAudio={play,get muted(){return muted;},toggle(){muted=!muted;if(muted)stop();try{localStorage.setItem('catan-sound-muted',String(muted));}catch(_){}return muted;}};
})();
