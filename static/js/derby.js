document.addEventListener('DOMContentLoaded', async () => {
    const $ = id => document.getElementById(id);
    const horses = Array.from({length: 10}, (_, i) => $(`horse-${i + 1}`));
    const names = [...$('horse-select').options].map(option => option.textContent);
    const key = 'peakdecline.derby.v2:' + document.body.dataset.accountId;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(key)); } catch (_) { /* Storage is optional. */ }
    const valid = saved && ['credits', 'races', 'wins'].every(k => Number.isSafeInteger(saved[k]) && saved[k] >= 0) && saved.wins <= saved.races;
    let credits = valid ? saved.credits : 1000;
    let races = valid ? saved.races : 0, wins = valid ? saved.wins : 0;
    let sync, hasData = !!valid;
    try {
        sync = await PeakSaves.connect({url:'/games/saves/derby',
            read:async()=>hasData?({'progress.json':PeakSaves.encode(new TextEncoder().encode(JSON.stringify({credits,races,wins})))}):{},
            write:async files=>{if(files['progress.json']){const p=JSON.parse(new TextDecoder().decode(PeakSaves.decode(files['progress.json'])));({credits,races,wins}=p);hasData=true;try{localStorage.setItem(key,JSON.stringify(p));}catch(_){}}},
            report:message=>$('save-note').textContent=message});
    } catch(error) { $('save-note').textContent=error.message; return; }
    window.peakFlushAccountSave=sync.flush;
    hasData=true;
    sync.flush().catch(error=>$('save-note').textContent=error.message);
    if (credits < 10) credits = 1000;
    let phase = 'ready', paused = false, elapsed = 0, lastTime = null;
    let stake = 0, pick = 0, runners = [], order = horses.map((_, i) => i);
    const positions = Array(10).fill(0);
    const container = document.querySelector('.game-container');
    let standingsKey = '';
    function presentation() {
        container.dataset.phase = phase;
        container.dataset.paused = String(paused);
        $('race-phase').textContent = paused ? 'RACE PAUSED' : ({ready: 'AT THE GATES', countdown: 'UNDER STARTER’S ORDERS', racing: 'RACE IN PROGRESS', finished: 'OFFICIAL RESULT'})[phase];
        $('track-overlay').hidden = !paused && phase !== 'countdown';
        $('overlay-caption').textContent = paused ? 'TAKE YOUR TIME' : 'UNDER STARTER’S ORDERS';
        $('overlay-value').textContent = paused ? 'Ⅱ' : String(3 - Math.floor(elapsed));
        $('race-meter-fill').style.width = `${Math.max(...positions) * 100}%`;
    }
    function save() {
        try { localStorage.setItem(key, JSON.stringify({credits, races, wins})); }
        catch (_) { /* Server synchronization remains available. */ }
        sync.flush().catch(error => $('save-note').textContent = error.message);
    }
    function wallet() {
        $('bankroll-display').textContent = credits.toLocaleString();
        $('bet-amount').max = credits;
        $('race-stats').textContent = `${races} races · ${wins} wins`;
    }
    function standings() {
        const signature = `${order.join(',')}:${$('horse-select').value}`;
        if (signature === standingsKey) return;
        standingsKey = signature;
        $('race-standings').replaceChildren(...order.map((i, rank) => {
            const item = document.createElement('li');
            const selected = i === Number($('horse-select').value) - 1;
            const silk = document.createElement('span');
            silk.className = 'runner-silk'; silk.textContent = i + 1;
            silk.style.backgroundColor = horses[i].style.getPropertyValue('--jockey-color');
            const label = document.createElement('span'); label.className = 'runner-label';
            label.textContent = `${rank + 1}. ${names[i].match(/\((.*)\)/)?.[1] || names[i]}`;
            const detail = document.createElement('small'); detail.textContent = selected ? 'YOUR PICK' : `RUNNER ${String(i + 1).padStart(2, '0')}`;
            label.append(detail); item.append(silk, label);
            item.classList.toggle('your-pick', selected);
            return item;
        }));
    }
    function render() {
        const finish = document.querySelector('.finish-line').offsetLeft;
        // Align each horse's nose with the actual finish line at every viewport size.
        const distance = Math.max(1, finish - horses[0].offsetWidth - 10);
        horses.forEach((horse, i) => {
            horse.style.left = `${10 + positions[i] * distance}px`;
            horse.parentElement.classList.toggle('selected', i === Number($('horse-select').value) - 1);
        });
        presentation();
    }
    function animate(time) {
        if (phase !== 'countdown' && phase !== 'racing') return;
        if (lastTime !== null && !paused) elapsed += Math.min((time - lastTime) / 1000, 0.1);
        lastTime = time;
        if (!paused) {
            if (elapsed < 3) {
                $('race-announcer').textContent = `At the gates… ${3 - Math.floor(elapsed)}`;
                presentation();
            } else {
                phase = 'racing';
                const t = elapsed - 3;
                // Smooth, monotonic pace changes; finish time is independent of lane and screen size.
                runners.forEach((runner, i) => {
                    const u = Math.min(1, t / runner.duration);
                    positions[i] = u + runner.swing * Math.sin(2 * Math.PI * u) / (2 * Math.PI);
                    horses[i].classList.toggle('racing', positions[i] < 1);
                });
                order.sort((a, b) => positions[b] - positions[a] || runners[a].duration - runners[b].duration);
                render();
                standings();
                $('race-progress').textContent = `${Math.min(100, Math.floor(Math.max(...positions) * 100))}% · ${t.toFixed(1)}s`;
                $('race-announcer').textContent = t < 1 ? "And they're off!" : `${names[order[0]]} leads${Math.max(...positions) > 0.78 ? ' — the final stretch!' : ' the pack.'}`;
                if (positions.some(p => p >= 1)) {
                    horses[order[0]].classList.add('winner');
                    $('race-announcer').textContent = `${names[order[0]]} crosses first! The field is finishing…`;
                }
                if (positions.every(p => p >= 1)) { finish(); return; }
            }
        }
        requestAnimationFrame(animate);
    }
    function finish() {
        phase = 'finished';
        order.sort((a, b) => runners[a].duration - runners[b].duration);
        const winner = order[0], won = winner === pick;
        races++;
        if (won) { credits += stake * 9; wins++; }
        horses.forEach(h => h.classList.remove('racing'));
        horses[winner].classList.add('winner');
        // All runners have crossed; retain the exact order even on a dropped frame.
        positions.fill(1);
        render(); standings();
        $('standings-title').textContent = 'Official finish order';
        $('race-announcer').textContent = `${names[winner]} wins! ${won ? `You receive ${stake * 9} credits (+${stake * 8} net).` : `Your pick finished #${order.indexOf(pick) + 1}. ${stake} credits spent.`}`;
        if (credits < 10) { credits = 1000; $('race-announcer').textContent += ' A fresh 1,000 play credits are ready for another go.'; }
        $('race-progress').textContent = `Winner's time · ${runners[winner].duration.toFixed(2)}s`;
        $('btn-start').style.display = 'none';
        $('btn-reset').style.display = 'inline-block';
        $('btn-pause').hidden = true;
        wallet(); save();
    }
    $('btn-start').addEventListener('click', () => {
        if (phase !== 'ready') return;
        stake = Number($('bet-amount').value);
        if (!Number.isSafeInteger(stake) || stake < 10 || stake % 10 !== 0 || stake > credits) {
            $('race-announcer').textContent = 'Enter a stake in steps of 10, up to your available credits.';
            $('bet-amount').focus(); return;
        }
        pick = Number($('horse-select').value) - 1;
        credits -= stake; wallet(); save();
        runners = horses.map(() => ({duration: 12 + Math.random() * 5, swing: Math.random() * 1.5 - 0.75}));
        phase = 'countdown'; elapsed = 0; lastTime = null; paused = false;
        presentation();
        ['btn-start', 'horse-select', 'bet-amount'].forEach(id => $(id).disabled = true);
        $('btn-pause').hidden = false;
        $('btn-pause').textContent = 'Pause race';
        $('standings-title').textContent = 'Live standings';
        requestAnimationFrame(animate);
    });
    function pause(value) {
        paused = value; lastTime = null;
        $('btn-pause').textContent = paused ? 'Resume race' : 'Pause race';
        horses.forEach(h => h.style.animationPlayState = paused ? 'paused' : 'running');
        presentation();
        if (paused) $('race-announcer').textContent = 'Race paused. Resume when you’re ready.';
    }
    $('btn-pause').addEventListener('click', () => pause(!paused));
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && ['countdown', 'racing'].includes(phase)) pause(true);
    });
    $('btn-reset').addEventListener('click', () => {
        if (phase !== 'finished') return;
        phase = 'ready'; positions.fill(0); order = horses.map((_, i) => i);
        horses.forEach(h => h.classList.remove('winner'));
        ['btn-start', 'horse-select', 'bet-amount'].forEach(id => $(id).disabled = false);
        $('bet-amount').value = Math.min(Number($('bet-amount').value), credits);
        $('btn-start').style.display = 'inline-block'; $('btn-reset').style.display = 'none';
        $('standings-title').textContent = 'The field';
        $('race-announcer').textContent = 'Pick a horse and lock in your stake.';
        $('race-progress').textContent = 'Ready at the gates';
        render(); standings(); $('btn-start').focus();
    });
    $('horse-select').addEventListener('change', () => {render(); standings();});
    new ResizeObserver(render).observe(document.querySelector('.race-track-wrapper'));
    let legacy;
    try { legacy=JSON.parse(localStorage.getItem('peakdecline.derby.v1')); } catch(_) {}
    if(legacy && ['credits','races','wins'].every(k=>Number.isSafeInteger(legacy[k]) && legacy[k]>=0) && legacy.wins<=legacy.races){
        const button=document.createElement('button');button.textContent='Import previous browser progress';
        button.addEventListener('click',()=>{if(phase!=='ready')return;({credits,races,wins}=legacy);save();wallet();button.remove();});
        $('save-note').after(button);
    }
    wallet(); render(); standings();
});
