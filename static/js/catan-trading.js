/* Negotiated trades: the server validates every response and final exchange. */
(()=>{
    const client=window.CatanClient,root=document.querySelector('.catan-app');if(!client||!root)return;
    const panel=document.querySelector('#trade-panel'),A='/static/assets/catan/colonist/',baseResources=['wood','brick','wheat','sheep','ore'],commodities=['paper','cloth','coin'];
    let R=baseResources;
    const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const empty=()=>Object.fromEntries(R.map(r=>[r,0]));
    let room,mode='players',give=empty(),want=empty(),counter=null,identity=null;
    const hub=document.createElement('div');hub.id='trade-hub';hub.hidden=true;panel.append(hub);
    const img=(r)=>`<img src="${commodities.includes(r)?`${A}cities-knights/card_${r}.svg`:`${A}card-${r}.svg`}" alt="${r}">`;
    const avatar=i=>`<span class="trade-avatar" title="${esc(room.game.players[i].name)}"><img src="${A}player-${['red','blue','orange','green','purple','white'][room.game.players[i].color??i]}.svg" alt="${esc(room.game.players[i].name)}"><img class="trade-person" src="${A}player-icon.svg" alt=""></span>`;
    const blockedPair=(a,b)=>room.game.embargo?.[String(a)]?.includes(b)||room.game.embargo?.[String(b)]?.includes(a);
    const blocked=i=>blockedPair(room.seat,i);
    // Ports in the engine use edge endpoints, not a separate vertex list.
    function bankRate(r){const s=room.game;if(s.mode==='cities-knights')return s.tradeRates?.[r]??4;let n=4;for(const p of s.ports){const ends=window.CatanEngine.edges[p.edge].ends;if(ends.some(v=>s.buildings[v]?.owner===room.seat)&&(p.type==='any'||p.type===r))n=Math.min(n,p.type==='any'?3:2);}return n;}
    const bankStock=r=>commodities.includes(r)?room.game.commodityBank?.[r]??0:room.game.bank?.[r]??0;
    function reset(){give=empty();want=empty();counter=null;}
    function terms(b){return R.filter(r=>b[r]).map(r=>`<span class="trade-term">${img(r)}<b>${b[r]}</b></span>`).join('')||'<span class="trade-wildcard" title="Open-ended: suggest resources">? Anything</span>';}
    function render(){
        if(!room?.game||room.tradeVersion!==2){hub.hidden=true;panel.classList.remove('negotiated-trading');return;}
        hub.hidden=false;panel.classList.add('negotiated-trading');
        const s=room.game,me=s.players[room.seat],active=room.seat===s.current,playing=s.phase==='build'&&!!me,hand={...me?.resources,...me?.commodities};
        if(counter&&!s.offers.some(o=>o.id===counter))reset();
        const selected=Object.values(give).some(Boolean)||Object.values(want).some(Boolean);
        const affordable=R.every(r=>give[r]<=hand[r]&&!(give[r]&&want[r]));
        const credits=R.reduce((n,r)=>n+give[r]/bankRate(r),0);
        const bankValid=active&&playing&&credits>0&&credits===Object.values(want).reduce((a,b)=>a+b,0)&&R.every(r=>give[r]%bankRate(r)===0&&want[r]<=bankStock(r));
        const canOffer=playing&&affordable&&selected&&(active||counter&&Object.values(give).some(Boolean)&&Object.values(want).some(Boolean));
        const cards=(side,values)=>R.map(r=>{const step=side==='give'&&mode==='bank'?bankRate(r):1;const max=side==='give'?hand[r]??0:mode==='bank'?bankStock(r):19;return `<div class="trade-pick"><button data-pick="${side}" data-resource="${r}" ${!playing||values[r]+step>max||(side==='give'?want:give)[r]?'disabled':''} aria-label="Add ${r} to ${side}">${img(r)}<b>${values[r]}</b></button><button data-minus="${side}" data-resource="${r}" ${!values[r]?'disabled':''} aria-label="Remove ${r} from ${side}">−</button>${side==='give'&&mode==='bank'?`<small>${bankRate(r)}:1</small>`:''}</div>`;}).join('');
        hub.innerHTML=`<h2>Trade</h2><div class="trade-modes"><button data-mode="players" aria-pressed="${mode==='players'}">Players</button><button data-mode="bank" aria-pressed="${mode==='bank'}" ${!active?'disabled':''}>Bank / ports</button></div><p class="trade-context">${counter?'Counteroffer · from your perspective':mode==='bank'?'Your port rates apply automatically':active?'Choose cards, then offer to the table':'Respond below or edit an offer to counter'}</p><div class="trade-selection"><strong>↑ You give</strong><div class="trade-card-row">${cards('give',give)}</div><strong>↓ You receive</strong><div class="trade-card-row">${cards('want',want)}</div></div><div class="trade-submit"><button id="submit-negotiated-trade" ${!(mode==='bank'?bankValid&&affordable:canOffer)?'disabled':''}>${mode==='bank'?'Trade with bank':counter?'Send counteroffer':'Offer trade'}</button><button id="clear-trade-selection">Clear</button></div><p class="trade-context">${mode==='bank'?`${credits} card${credits===1?'':'s'} available from the bank`:counter?'Select specific cards on both sides.':'Leave one side empty for an open-ended offer.'}</p><div id="negotiated-offers"></div>`;
        const offers=hub.querySelector('#negotiated-offers');
        const composer=document.createElement('details');composer.className='trade-composer';composer.open=!s.offers.length||selected;
        const composerTitle=document.createElement('summary');composerTitle.textContent=counter?'Edit counteroffer':'Create trade';composer.append(composerTitle);
        for(const child of [...hub.children])if(child!==offers&&child.tagName!=='H2')composer.append(child);
        hub.querySelector('h2').remove();hub.insertBefore(composer,offers);
        offers.innerHTML=mode==='bank'?'':s.offers.map(o=>{
            const author=o.author??s.current;
            const response=o.responses?.[String(room.seat)];
            const concrete=Object.values(o.give).some(Boolean)&&Object.values(o.want).some(Boolean);
            const canAccept=playing&&!active&&!o.allRejected&&!blocked(s.current)&&concrete&&R.every(r=>hand[r]>=o.want[r]);
            const responses=s.players.map((p,i)=>i===s.current?'':`<div class="trade-response"><span>${esc(p.name)}</span><span>${blockedPair(s.current,i)?'🚫 Not trading':({accepted:'✓ Accepted',rejected:'✕ Declined'})[o.responses?.[String(i)]]||'… Waiting'}</span>${active?`<button data-confirm="${o.id}" data-target="${i}" ${o.responses?.[String(i)]!=='accepted'||blocked(i)||!playing?'disabled':''}>Trade</button>`:''}</div>`).join('');
            return `<article class="negotiated-offer"><strong>${esc(s.players[author].name)}${author===s.current?' offers':' counters'}</strong><div class="trade-terms"><span>${esc(s.players[s.current].name)} gives</span>${terms(o.give)}</div><div class="trade-terms"><span>Wants</span>${terms(o.want)}</div>${responses}<div class="trade-response-actions">${!active&&me?`<button data-respond="accept-trade" data-offer-id="${o.id}" ${!canAccept||response==='accepted'?'disabled':''}>✓ Accept</button><button data-respond="reject-trade" data-offer-id="${o.id}" ${!playing||blocked(s.current)||response==='rejected'?'disabled':''}>✕ Decline</button><button data-edit="${o.id}" ${!playing||blocked(s.current)?'disabled':''}>Edit / counter</button>`:''}${active?`<button data-edit="${o.id}">Edit offer</button>`:''}${active||author===room.seat?`<button data-cancel="${o.id}">Cancel</button>`:''}</div></article>`;
        }).join('');
        for(const [index,offer] of [...offers.querySelectorAll('.negotiated-offer')].entries()){
            const o=s.offers[index],author=o.author??s.current;
            offer.querySelector('strong').innerHTML=avatar(author)+`<span>${esc(s.players[author].name)}</span>`;
            const rows=offer.querySelectorAll('.trade-terms');
            rows[0].querySelector('span').outerHTML=avatar(s.current)+'<span class="trade-arrow receive" title="Offered resources">↓</span>';
            rows[1].querySelector('span').outerHTML=(me?avatar(room.seat):avatar(s.current))+'<span class="trade-arrow give" title="Requested resources">↑</span>';
            const responses=document.createElement('div');responses.className='trade-response-icons';
            for(const [responseIndex,responseRow] of [...offer.querySelectorAll('.trade-response')].entries()){
                const i=s.players.map((p,i)=>i).filter(i=>i!==s.current)[responseIndex],name=s.players[i].name;
                const status=blockedPair(s.current,i)?'blocked':o.responses?.[String(i)]||'waiting';
                responseRow.querySelector('span').innerHTML=avatar(i);
                responseRow.children[1].textContent=({accepted:'✓',rejected:'✕',blocked:'🚫',waiting:'…'})[status];
                responseRow.title=name+': '+(status==='blocked'?'not trading by preference':status);responses.append(responseRow);
            }
            rows[0].append(responses);
            for(const button of offer.querySelectorAll('.trade-response-actions button')){
                const label=button.textContent;button.title=label;button.setAttribute('aria-label',label);
                button.textContent=button.dataset.edit?'Edit':button.dataset.respond==='accept-trade'?'✓ Accept':button.dataset.respond==='reject-trade'?'✕ Decline':'Cancel';
            }
            rows[1].append(offer.querySelector('.trade-response-actions'));
        }
        if(me&&mode==='players')offers.insertAdjacentHTML('beforeend',`<details class="trade-preferences"><summary>Player trade preferences</summary>${s.players.map((p,i)=>i===room.seat?'':`<button data-embargo="${i}" ${!playing?'disabled':''}>${s.embargo?.[String(room.seat)]?.includes(i)?'Allow':'Block'} trades with ${esc(p.name)}</button>`).join('')}</details>`);
    }
    root.addEventListener('click',async e=>{
        if(room?.tradeVersion!==2)return;
        const b=e.target.closest('button');
        if(b&&hub.contains(b)){
            if(b.disabled)return;e.preventDefault();e.stopImmediatePropagation();
            if(b.dataset.mode){mode=b.dataset.mode;reset();render();return;}
            if(b.dataset.pick||b.dataset.minus){const side=b.dataset.pick||b.dataset.minus,r=b.dataset.resource,values=side==='give'?give:want,step=side==='give'&&mode==='bank'?bankRate(r):1;values[r]=Math.max(0,values[r]+(b.dataset.minus?-step:step));render();return;}
            if(b.id==='clear-trade-selection'){reset();render();return;}
            if(b.dataset.edit){const o=room.game.offers.find(o=>o.id===b.dataset.edit);if(!o)return;mode='players';const active=room.seat===room.game.current;give={...(active?o.give:o.want)};want={...(active?o.want:o.give)};counter=active?null:o.id;render();return;}
            let action;
            if(b.id==='submit-negotiated-trade')action=mode==='bank'?{type:'bank-trade',give,receive:want}:{type:counter?'counter-trade':'offer',offer:counter,give,want};
            else if(b.dataset.respond)action={type:b.dataset.respond,offer:b.dataset.offerId};
            else if(b.dataset.confirm)action={type:'confirm-trade',offer:b.dataset.confirm,target:Number(b.dataset.target)};
            else if(b.dataset.cancel)action={type:'cancel-trade',offer:b.dataset.cancel};
            else if(b.dataset.embargo)action={type:'embargo',target:Number(b.dataset.embargo)};
            if(action){
                const sent=await client.action(action);
                if(sent&&['bank-trade','offer','counter-trade','confirm-trade'].includes(action.type)){reset();render();}
                if(sent&&['accept-trade','reject-trade','confirm-trade','cancel-trade'].includes(action.type))root.classList.remove('trading');
            }return;
        }
        const card=e.target.closest('#resources [data-resource], #ck-commodities [data-trade-resource]');
        if(card&&room.game&&room.seat!==null){root.classList.add('trading');const r=card.dataset.resource||card.dataset.tradeResource,step=mode==='bank'?bankRate(r):1,hand=commodities.includes(r)?room.game.players[room.seat].commodities:room.game.players[room.seat].resources;if(!want[r]&&give[r]+step<=hand[r])give[r]+=step;render();}
        if(b?.id==='open-trade')render();
    },true);
    root.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('#resources [data-resource], #ck-commodities [data-trade-resource]')){e.preventDefault();e.target.click();}});
    client.subscribe(next=>{R=next.game?.mode==='cities-knights'?[...baseResources,...commodities]:baseResources;const key=next.id+':'+next.seat+':'+next.game?.mode+':'+next.game?.turn;if(key!==identity){identity=key;reset();mode='players';}room=next;render();});
})();
