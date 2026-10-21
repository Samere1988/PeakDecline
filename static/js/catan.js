(() => {
    'use strict';
    const root=document.querySelector('.catan-app');if(!root)return;
    const E=window.CatanEngine, UI=window.CatanUI, A='/static/assets/catan/colonist/', colors=['red','blue','orange','green','purple','white'];
    const baseGeometry=Object.fromEntries(['tiles','vertices','edges','ports'].map(key=>[key,structuredClone(E[key])]));
    function useGeometry(geometry){
        const selectedGeometry=geometry||baseGeometry;
        for(const key of ['tiles','vertices','edges','ports'])E[key].splice(0,E[key].length,...selectedGeometry[key]);
    }
    const $=s=>root.querySelector(s), escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let state=E.create([root.dataset.playerName||'You','Player 2','Player 3','Player 4']), selected=null;
    const sound=window.CatanAudio;
    const client=window.CatanClient;
    // Also normalize cached server templates that still put development cards
    // beneath the build buttons. Both hands belong to the same compact dock.
    if(client){
        const boardStyle=document.createElement('link');boardStyle.rel='stylesheet';boardStyle.href='/static/css/catan-board-first.css?v=shared-ui-v2';document.head.append(boardStyle);
        $('.bottom-hand').append($('#development-hand'));
        $('.board-toolbar .toolbar-actions').prepend($('#dice-display'));
        $('#dice-display').before($('#turn-label'));
        root.classList.add('board-first');
        const chat=$('#chat-panel'),history=$('#room-history'),historyDetails=history.closest('details');
        const summary=document.createElement('section');summary.className='move-summary sidebar-card';
        const heading=document.createElement('h2');heading.textContent='Moves';summary.append(heading,history);
        chat.before(summary);historyDetails.remove();
        const chatToggle=document.createElement('details'),chatLabel=document.createElement('summary');
        chatToggle.className='chat-toggle';chatToggle.open=true;chatLabel.textContent='Chat';chatToggle.append(chatLabel);
        chat.querySelector('.card-heading').remove();
        chatToggle.append(...chat.childNodes);chat.append(chatToggle);
    }
    let seat=null,devChoice=null,devPicks=[],lastVersion=-1,lastGameRevision=-1,lastRoomId=null,lastViewSeat=null,tradeDeclineTimer=null,highlightUntil=0,highlightTimer=null;
    function flashProduction(){
        highlightUntil=Date.now()+1600;
        clearTimeout(highlightTimer);
        highlightTimer=setTimeout(()=>{highlightUntil=0;root.querySelectorAll('.hex.producing').forEach(tile=>tile.classList.remove('producing'));},1600);
    }
    const colorIndex=i=>state.players[i]?.color??i;
    const color=i=>colors[colorIndex(i)];
    const ownTurn=()=>state.phase!=='waiting'&&(!client||seat===state.current);
    const canBuild=()=>ownTurn()&&['build','free-road','special-build'].includes(state.phase);
    if(client){
        E.legal=(s,kind)=>s.legal?.[kind]||[];
        E.total=p=>p.cardCount??Object.values(p.resources||{}).reduce((a,b)=>a+b,0);
    }
    const image=(file,cls='',alt='')=>`<img class="${cls}" src="${A}${file}.svg" alt="${escape(alt)}" draggable="false">`;
    const purchaseCosts={road:{wood:1,brick:1},settlement:{wood:1,brick:1,wheat:1,sheep:1},city:{wheat:2,ore:3},development:{wheat:1,sheep:1,ore:1}};
    const costTooltip=document.createElement('div');costTooltip.className='catan-cost-tooltip';costTooltip.hidden=true;costTooltip.setAttribute('role','tooltip');document.body.append(costTooltip);
    let costAnchor=null;
    function showCost(anchor){
        const kind=anchor.dataset.cost,hand=client?state.players[seat]:state.players[state.phase==='discard'?state.discard[0].owner:state.current];
        if(!purchaseCosts[kind]||!hand)return;
        costAnchor=anchor;
        costTooltip.innerHTML=`<strong>${escape(kind==='development'?'Development card':kind[0].toUpperCase()+kind.slice(1))}</strong><div class="catan-cost-cards">${Object.entries(purchaseCosts[kind]).map(([resource,count])=>`<span class="catan-cost-card ${(hand.resources?.[resource]||0)>=count?'available':'missing'}" aria-label="${count} ${resource}: ${(hand.resources?.[resource]||0)>=count?'available':'missing'}">${image('card-'+resource,'',resource)}<b>${count}</b></span>`).join('')}</div>`;
        costTooltip.hidden=false;
        const rect=anchor.getBoundingClientRect(),width=costTooltip.offsetWidth;
        costTooltip.style.left=`${Math.max(8,Math.min(window.innerWidth-width-8,rect.left+rect.width/2-width/2))}px`;
        costTooltip.style.top=`${Math.max(8,rect.top-costTooltip.offsetHeight-8)}px`;
    }
    for(const button of root.querySelectorAll('.action-tray [data-build], #buy-development')){
        const anchor=document.createElement('div');anchor.className='action-cost-anchor';anchor.dataset.cost=button.dataset.build||'development';
        button.before(anchor);anchor.append(button);
        anchor.addEventListener('pointerenter',()=>showCost(anchor));
        anchor.addEventListener('pointerleave',()=>{costTooltip.hidden=true;costAnchor=null;});
        anchor.addEventListener('focusin',()=>showCost(anchor));
        anchor.addEventListener('focusout',()=>{costTooltip.hidden=true;costAnchor=null;});
    }
    const xy=(x,y)=>`left:${x}%;top:${y}%`;
    let receiptTimer;
    const receipt=document.createElement('div');receipt.className='card-receipt';receipt.setAttribute('role','status');root.append(receipt);
    const summaryButton=document.createElement('button');summaryButton.id='show-game-summary';summaryButton.type='button';summaryButton.textContent='Game summary';summaryButton.hidden=true;$('.toolbar-actions').append(summaryButton);
    const summaryOverlay=document.createElement('div');summaryOverlay.id='game-summary-overlay';summaryOverlay.hidden=true;summaryOverlay.setAttribute('role','dialog');summaryOverlay.setAttribute('aria-modal','true');summaryOverlay.setAttribute('aria-labelledby','game-summary-title');root.append(summaryOverlay);
    let summaryShownFor=null;
    function renderGameSummary(){
        const rolls=(state.rolls||[]).filter(roll=>Array.isArray(roll.dice)&&roll.dice.length===2&&roll.dice.every(d=>Number.isInteger(d)&&d>=1&&d<=6));
        const counts=Array(13).fill(0);for(const roll of rolls)counts[roll.dice[0]+roll.dice[1]]++;
        const maximum=Math.max(1,...counts),winner=state.winner===null?'Game ended':`${escape(state.players[state.winner].name)} wins!`;
        const chart=counts.slice(2).map((count,index)=>`<div class="roll-column"><div class="roll-bar-area"><strong>${count}</strong><span class="roll-bar ${index+2===7?'roll-seven':''}" style="height:${count/maximum*100}%"></span></div><span>${index+2}</span></div>`).join('');
        const history=rolls.map((roll,index)=>`<li><span>#${index+1}</span><span>${escape(state.players[roll.player]?.name||'Player')}</span><span class="roll-faces">${roll.dice.map(d=>image('dice-'+d,'',`Die ${d}`)).join('')}</span><strong>${roll.dice[0]+roll.dice[1]}</strong></li>`).join('');
        const partial=state.rollHistoryPartial||!Array.isArray(state.rolls);
        summaryOverlay.innerHTML=`<section class="game-summary-card"><header><div><h2 id="game-summary-title">${winner}</h2><p>${rolls.length} recorded dice roll${rolls.length===1?'':'s'}</p></div><button id="close-game-summary" type="button" aria-label="Close game summary">×</button></header>${partial?'<p class="roll-history-note">Rolls before this update were not saved.</p>':''}<h3>Roll totals</h3><div class="roll-chart" role="img" aria-label="Roll counts: ${counts.slice(2).map((n,i)=>`${i+2}: ${n}`).join(', ')}">${chart}</div><h3>Every roll</h3><ol class="roll-history">${history||'<li>No dice rolls recorded.</li>'}</ol></section>`;
    }
    function syncGameSummary(){
        const finished=state.phase==='finished',key=client?.room?.id||'local';
        summaryButton.hidden=!finished;
        if(!finished){summaryOverlay.hidden=true;summaryShownFor=null;return;}
        if(summaryShownFor!==key){renderGameSummary();summaryShownFor=key;summaryOverlay.hidden=false;root.classList.remove('trading');summaryOverlay.querySelector('#close-game-summary').focus();}
    }
    root.addEventListener('click',event=>{
        const id=event.target.closest('button')?.id;
        if(id==='show-game-summary'){summaryOverlay.hidden=false;summaryOverlay.querySelector('#close-game-summary').focus();}
        if(id==='close-game-summary'){summaryOverlay.hidden=true;summaryButton.focus();}
    });
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!summaryOverlay.hidden){summaryOverlay.hidden=true;summaryButton.focus();}});
    function receivedCards(previous,next){
        if(next.mode==='cities-knights')return;
        if(seat===null||!previous.players[seat]?.resources||!next.players[seat]?.resources)return;
        const changes=E.resources.map(r=>[r,next.players[seat].resources[r]-previous.players[seat].resources[r]]);
        const gains=changes.filter(([,n])=>n>0),losses=changes.filter(([,n])=>n<0);
        if(!gains.length&&!losses.length)return;
        const cards=items=>items.map(([r,n])=>`<span class="receipt-resource">${image('card-'+r,'',r)}<b>${Math.abs(n)}</b></span>`).join('');
        receipt.innerHTML=(gains.length?'<span>Received</span>'+cards(gains):'')+(losses.length?'<span>Lost</span>'+cards(losses):'');
        receipt.setAttribute('aria-label',[gains.length?'Received '+gains.map(([r,n])=>`${n} ${r}`).join(', '):'',losses.length?'Lost '+losses.map(([r,n])=>`${-n} ${r}`).join(', '):''].filter(Boolean).join('; '));
        receipt.classList.add('visible');clearTimeout(receiptTimer);receiptTimer=setTimeout(()=>receipt.classList.remove('visible'),2800);
        if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
        let count=0;
        for(const [r,n] of gains){
            const target=root.querySelector(`[data-resource="${r}"]`).getBoundingClientRect();
            let source=(root.querySelector(`.hex.resource-${r}.producing`)||$('#bank-resources')).getBoundingClientRect();
            if(!source.width)source=$('#board').getBoundingClientRect();
            for(let i=0;i<Math.min(n,3)&&count<10;i++,count++){
                const card=document.createElement('img');card.className='received-card';card.src=A+'card-'+r+'.svg';card.alt='';card.setAttribute('aria-hidden','true');document.body.append(card);
                const animation=card.animate([
                    {transform:`translate(${source.x+source.width/2-18}px,${source.y+source.height/2-27}px) rotate(-12deg) scale(.65)`,opacity:0},
                    {offset:.15,opacity:1},
                    {transform:`translate(${target.x+target.width/2-18}px,${target.y+target.height/2-27}px) rotate(0deg) scale(1)`,opacity:1}
                ],{duration:850,delay:count*65,easing:'cubic-bezier(.2,.7,.3,1)',fill:'both'});
                animation.finished.then(()=>card.remove(),()=>card.remove());
            }
        }
        for(const [r,n] of losses){
            const source=root.querySelector(`[data-resource="${r}"]`)?.getBoundingClientRect();
            const target=$('#bank-resources').getBoundingClientRect();
            if(!source)continue;
            for(let i=0;i<Math.min(-n,3)&&count<10;i++,count++){
                const card=document.createElement('img');card.className='received-card';card.src=A+'card-'+r+'.svg';card.alt='';card.setAttribute('aria-hidden','true');document.body.append(card);
                const animation=card.animate([
                    {transform:`translate(${source.x+source.width/2-18}px,${source.y+source.height/2-27}px) rotate(0deg) scale(1)`,opacity:1},
                    {offset:.85,opacity:1},
                    {transform:`translate(${target.x+target.width/2-18}px,${target.y+target.height/2-27}px) rotate(12deg) scale(.65)`,opacity:0}
                ],{duration:850,delay:count*65,easing:'cubic-bezier(.2,.7,.3,1)',fill:'both'});
                animation.finished.then(()=>card.remove(),()=>card.remove());
            }
        }
    }
    if(client){
        const close=document.createElement('button');close.id='close-trade';close.textContent='Close trade';$('#trade-panel').prepend(close);
        const sidebar=document.createElement('button');sidebar.id='toggle-sidebar';sidebar.className='secondary-button';sidebar.textContent='Players & chat';sidebar.setAttribute('aria-expanded','false');$('.catan-topbar').append(sidebar);
        const closeSide=document.createElement('button');closeSide.id='close-sidebar';closeSide.textContent='Back to board';$('.catan-sidebar').prepend(closeSide);
        root.addEventListener('click',e=>{
            const id=e.target.closest('button')?.id;
            if(id==='close-trade'){root.classList.remove('trading');$('#open-trade').focus();}
            if(id==='toggle-sidebar'||id==='close-sidebar'){root.classList.toggle('sidebar-open');sidebar.setAttribute('aria-expanded',String(root.classList.contains('sidebar-open')));}
        });
        document.addEventListener('keydown',e=>{if(e.key==='Escape'){root.classList.remove('trading','sidebar-open');sidebar.setAttribute('aria-expanded','false');}});
    }
    function message(){
        if(state.phase==='waiting')return 'Welcome to the board. Choose a seat or spectate, chat with the room, and ready up when you want to play.';
        const name=state.players[state.current].name;
        if(state.phase==='setup-settlement')return `${name}: choose ${state.setup<state.players.length?'your first':'your second'} settlement. Select a glowing corner.`;
        if(state.phase==='setup-road')return `${name}: choose a road connected to your new settlement.`;
        if(state.phase==='roll')return '';
        if(state.phase==='discard'){const d=state.discard.find(d=>d.owner===seat)||state.discard[0];return `${state.players[d.owner].name}: choose ${d.left} more cards to discard.`;}
        if(state.phase==='robber')return `${name}: choose a different tile for the robber.`;
        if(state.phase==='steal')return `${name}: choose a player to steal one random resource from.`;
        if(state.phase==='finished')return state.winner===null?'Match ended. The host can open a rematch.':`${state.players[state.winner].name} wins!`;
        if(state.phase==='free-road')return `${name}: place ${state.freeRoads} free road(s).`;
        if(state.phase==='special-build')return `${name}: Special Build Phase. Build, buy a development card, or finish. Trading and playing cards are unavailable.`;
        return selected?`Choose a highlighted location for your ${selected}.`:'';
    }
    function renderDevOptions(){
        const panel=$('#development-options');
        if(!devChoice){panel.hidden=true;panel.innerHTML='';return;}
        const names={knight:'Knight',monopoly:'Monopoly',roadbuilding:'Road Building',plenty:'Year of Plenty'};
        const descriptions={knight:'Move the robber to a new tile, then steal one random card from an adjacent player.',monopoly:'Take every card of one resource type from the other players.',roadbuilding:'Place up to two roads without paying resources.',plenty:'Take two resource cards from the bank.'};
        const need=devChoice==='monopoly'?1:devChoice==='plenty'?Math.min(2,Object.values(state.bank).reduce((sum,n)=>sum+n,0)):0;
        const choices=need?`<div class="dev-choice-grid" aria-label="Choose ${need} resource${need===1?'':'s'}">${E.resources.map(r=>{const chosen=devPicks.filter(p=>p===r).length,available=devChoice==='monopoly'||(state.bank[r]||0)>chosen;return `<button type="button" data-dev-pick="${r}" ${!available||devPicks.length>=need?'disabled':''} aria-label="Choose ${r}${chosen?`, selected ${chosen}`:''}">${image('card-'+r,'',r)}<b>${chosen||''}</b><span>${r}</span></button>`;}).join('')}</div><p class="dev-selected">${devPicks.length?`Selected: ${devPicks.map(r=>escape(r)).join(', ')}`:`Choose ${need} ${need===1?'resource':'resources'}.`}</p>`:'';
        panel.innerHTML=`<div class="dev-play-card">${image('dev-'+devChoice,'',names[devChoice])}</div><div class="dev-play-body"><h2>${names[devChoice]}</h2><p>${descriptions[devChoice]}</p>${choices}<div class="dev-play-actions"><button id="cancel-development" type="button">Cancel</button><button id="confirm-development" type="button" ${devPicks.length<need?'disabled':''}>Play card</button></div></div>`;
        panel.hidden=false;
    }
    function board(){
        const expanded=state.map==='base-56', tileWidth=expanded?16:18, tileHeight=expanded?18:24, boardRatio=expanded ? 0.973 : 1.1533;
        const kind=state.phase.startsWith('setup')?state.phase.slice(6):state.phase==='free-road'?'road':selected;
        const legal=kind?(client?state.legal?.[kind]||[]:E.legal(state,kind)):[];
        let html='',lines='';
        E.tiles.forEach(t=>{
            const hot=[6,8].includes(t.number),produced=Date.now()<highlightUntil&&state.dice&&state.dice[0]+state.dice[1]===t.number&&state.robber!==t.id;
            html+=`<div class="hex resource-${t.type} ${produced?'producing':''}" style="${xy(t.x,t.y)}" role="img" aria-label="${t.type}${t.number?', roll '+t.number:''}">${image('terrain-'+t.type,'terrain-image')}<div class="hex-inner">${t.number?`<span class="number ${hot?'hot':''}">${t.number}<small class="number-pips">${'•'.repeat(6-Math.abs(7-t.number))}</small></span>`:'<span class="desert-label">Desert</span>'}</div></div>`;
            if(state.robber===t.id)html+=`<div class="robber-piece" style="${xy(t.x+tileWidth*2/3,t.y+tileHeight/3)}">${image('robber','','Robber')}</div>`;
            if(ownTurn()&&state.phase==='robber'&&state.robber!==t.id)html+=`<button class="robber-target" data-tile="${t.id}" style="${xy(t.x+tileWidth/2,t.y+tileHeight/2)}" aria-label="Move robber to ${t.type} ${t.number||'desert'}">⌖</button>`;
        });
        E.ports.forEach(p=>{
            const edge=E.edges[p.edge], [a,b]=edge.ends.map(v=>E.vertices[v]), land=E.tiles[edge.tiles[0]];
            const x=a.x+b.x-land.x-tileWidth/2,y=a.y+b.y-land.y-tileHeight/2;
            [a,b].forEach(v=>{
                const angle=Math.atan2((y-v.y)/boardRatio,x-v.x)*180/Math.PI-90;
                lines+=`<image class="port-pier" href="${A}port-pier.png" x="-1.04" y="-3.12" width="2.08" height="6.24" transform="translate(${v.x+(x-v.x)/3} ${v.y+(y-v.y)/3}) scale(1 ${boardRatio}) rotate(${angle})"/>`;
            });
            html+=`<div class="coastal-port" data-port-edge="${p.edge}" style="${xy(x,y-2)}" title="${p.type==='any'?'Any resource 3:1':p.type+' 2:1'}">${image('port-'+p.type,'port-icon',p.type==='any'?'3 to 1 port':p.type+' 2 to 1 port')}</div>`;
        });
        E.edges.forEach(e=>{
            const [a,b]=e.ends.map(v=>E.vertices[v]),owner=state.roads[e.id];
            if(owner!==undefined){
                const dx=b.x-a.x,dy=(b.y-a.y)/boardRatio,length=Math.hypot(dx,dy);
                const angle=Math.atan2(dy,dx)*180/Math.PI-90;
                lines+=`<image class="placed-road" href="${A}road-${color(owner)}.svg" x="-1.1" y="${-length/2}" width="2.2" height="${length}" transform="translate(${(a.x+b.x)/2} ${(a.y+b.y)/2}) scale(1 ${boardRatio}) rotate(${angle})"/>`;
            }
            if(kind==='road'&&legal.includes(e.id))html+=`<button class="placement-target road-target" style="${xy((a.x+b.x)/2,(a.y+b.y)/2)}" data-place="${e.id}" aria-label="Place road ${e.id+1}">+</button>`;
        });
        html=`<svg class="board-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>`+html;
        E.vertices.forEach(v=>{
            const b=state.buildings[v.id];
            if(b)html+=`<img class="board-piece" style="${xy(v.x,v.y)}" src="${A}${b.kind}-${color(b.owner)}.svg" alt="${escape(state.players[b.owner].name)} ${b.kind}">`;
            if(kind!=='road'&&legal.includes(v.id))html+=`<button class="placement-target" style="${xy(v.x,v.y)}" data-place="${v.id}" aria-label="Place ${kind} at corner ${v.id+1}">+</button>`;
        });
        $('#board').innerHTML=`<div class="hex-board ${expanded?'base-six':''}">${html}</div>`;
    }
    function render(){
        board();const p=state.players[state.current],setup=state.phase.startsWith('setup');
        $('#sound-toggle').textContent=sound.muted?'Sound off':'Sound on';
        $('#sound-toggle').setAttribute('aria-pressed',String(!sound.muted));
        $('#turn-label').textContent=state.winner!==null?`${state.players[state.winner].name} wins!`:`${p.name} · ${setup?'Starting placement':state.phase==='special-build'?'Special Build Phase':ownTurn()?'Your turn':'Playing'}`;
        if(state.phase==='waiting')$('#turn-label').textContent='Waiting for players';
        $('#game-status').textContent=setup?`Setup ${state.setup+1}/${state.players.length*2}`:state.map==='base-56'?'5–6 player map':client?'Online':'Local hotseat';
        $('#players').innerHTML=state.players.map((p,i)=>UI.seat({player:p,index:i,current:state.current,viewer:client?seat:null,finished:state.phase==='finished',cardCount:E.total(p),secondCard:{src:A+'card-development.svg',count:p.devCount??0,label:'Development cards'},extras:`<div class="award-stat" title="Knights played${state.army===i?' · Largest army':''}">${image('largest-army')}<span>${p.knights??'—'}${state.army===i?' ★':''}</span></div><div class="award-stat" title="Longest connected road${state.longest===i?' · Longest road award':''}">${image('longest-road')}<span>${p.longest??15-p.road}${state.longest===i?' ★':''}</span></div>`})).join('');
        $('#bank-resources').innerHTML=UI.bank({cards:[...E.resources.map(r=>({src:A+'card-'+r+'.svg',count:state.bank[r],label:`${state.bank[r]} ${r} in bank`})),{src:A+'card-development.svg',count:state.deckCount??'—',label:'Development cards remaining'}]});
        const hand=client?(state.players[seat]||{name:'Spectator',resources:Object.fromEntries(E.resources.map(r=>[r,0])),vp:0,road:0,settlement:0,city:0}):state.phase==='discard'?state.players[state.discard[0].owner]:p;
        if(costAnchor)showCost(costAnchor);
        $('#hand-title').textContent=hand.name==='You'?'Your hand':`${hand.name}'s hand`;
        $('#resources').innerHTML=E.resources.map(r=>`<div class="resource" data-resource="${r}" ${client?'role="button" tabindex="0" title="Select for trade"':''} aria-label="${hand.resources[r]} ${r}">${image('card-'+r,'resource-card-image')}<span class="resource-label">${r}</span><span class="resource-count">${hand.resources[r]}</span></div>`).join('');
        $('#hand-count').textContent=`${E.total(hand)} cards`;$('#victory-points').textContent=`${client&&seat!==null&&hand.totalVP>hand.vp?`${hand.vp}(${hand.totalVP})`:hand.vp} VP`;
        $('#dev-cards').textContent=`Pieces left: ${hand.road} roads · ${hand.settlement} settlements · ${hand.city} cities`;
        $('#roll-dice').disabled=!ownTurn()||state.phase!=='roll';$('#end-turn').disabled=!ownTurn()||!['build','special-build'].includes(state.phase);
        $('#end-turn span').textContent=state.phase==='special-build'?'Finish build':'End turn';
        $('#new-game').hidden=!!client;
        root.querySelectorAll('[data-build]').forEach(b=>{b.disabled=!canBuild()||(state.phase!=='free-road'&&!E.affordable(state,b.dataset.build))||!E.legal(state,b.dataset.build).length;b.classList.toggle('selected',selected===b.dataset.build);b.setAttribute('aria-pressed',selected===b.dataset.build?'true':'false');});
        root.querySelectorAll('.build-piece-image').forEach(img=>img.src=A+img.dataset.piece+'-'+color(client?(seat??0):state.current)+'.svg');
        root.querySelectorAll('[data-supply]').forEach(el=>el.textContent=hand[el.dataset.supply]);
        $('#dice-display').innerHTML=state.dice?UI.dice(state.dice):'<span>Place your starting pieces to unlock the first roll</span>';
        $('#game-message').textContent=message();syncGameSummary();
        let actions='';
        if(state.phase==='discard'&&(!client||state.discard.some(d=>d.owner===seat)))actions=E.resources.map(r=>`<button data-discard="${r}" ${hand.resources[r]?'':'disabled'}>Discard ${r}</button>`).join('');
        if(state.phase==='steal'&&ownTurn())actions=state.victims.map(i=>`<button data-steal="${i}">Steal from ${escape(state.players[i].name)}</button>`).join('');
        if(client&&state.map==='base-56'&&seat!==null&&seat!==state.current&&['roll','build','free-road','discard','robber','steal'].includes(state.phase))
            actions+=`<button data-special-build-flag aria-pressed="${(state.specialFlags||[]).includes(seat)}">${(state.specialFlags||[]).includes(seat)?'✓ Special build requested':'Request special build'}</button>`;
        $('#phase-actions').innerHTML=actions;updateTrade();
        $('#buy-development').disabled=!client||!ownTurn()||!['build','special-build'].includes(state.phase)||!state.deckCount||!['wheat','ore','sheep'].every(r=>hand.resources[r]>=1);
        if(client){
            const devNames={knight:'Knight',monopoly:'Monopoly',roadbuilding:'Road Building',victory:'Victory Point',plenty:'Year of Plenty'};
            const devEffects={knight:'Move the robber and steal one random resource from a player beside its new tile. Played knights count toward Largest Army.',monopoly:'Name a resource. Every other player gives you all cards of that resource.',roadbuilding:'Place up to two roads for free.',victory:'Worth one hidden victory point. It counts automatically and is revealed when you win.',plenty:'Take any two available resource cards from the bank.'};
            $('#development-hand').innerHTML=(hand.dev||[]).map(d=>{
                const disabled=!ownTurn()||!['roll','build'].includes(state.phase)||state.playedDev||d.bought>=state.turn||d.kind==='victory';
                const description=`${devNames[d.kind]||d.kind}: ${devEffects[d.kind]||''}${d.bought===state.turn?' Playable starting next turn.':''}`;
                return `<span class="development-card-wrap" title="${escape(description)}" aria-label="${escape(description)}"><button class="development-card" data-dev="${d.kind}" ${disabled?'disabled':''} title="${escape(description)}"><img src="${A}dev-${d.kind}.svg" alt=""><span>${escape(devNames[d.kind]||d.kind)}</span>${d.bought===state.turn?'<b>NEW</b>':''}</button></span>`;
            }).join('');
            $('#offer-trade').disabled=!ownTurn()||state.phase!=='build';
            $('#open-trade').disabled=state.phase==='special-build';
            const describe=b=>Object.entries(b).filter(([,n])=>n).map(([r,n])=>`${n} ${r}`).join(', ');
            $('#player-offers').innerHTML=(state.offers||[]).map(o=>`<p>${escape(state.players[state.current].name)} gives ${describe(o.give)} for ${describe(o.want)}.</p>${ownTurn()?'<button id="cancel-trade">Cancel offer</button>':`<button data-offer="${o.id}" ${seat===null?'disabled':''}>Accept trade</button>`}`).join('');
        }
    }
    function updateTrade(){const from=$('#trade-from').value,to=$('#trade-to').value,n=E.rate(state,from);$('#trade-button').textContent=`Trade ${n} for 1`;$('#trade-button').disabled=!ownTurn()||state.phase!=='build'||from===to||state.players[state.current].resources[from]<n||state.bank[to]<1;$('#trade-rate').textContent=`${n}:1 ${n===4?'bank rate':'port rate'} · Bank has ${state.bank[to]} ${to}`;}
    root.addEventListener('click',event=>{
        const b=event.target.closest('button');if(!b||b.disabled)return;
        if(b.id==='sound-toggle'){sound.toggle();if(!sound.muted)sound.play('sfx_click');render();return;}
        if(client){
            if(b.dataset.build){selected=selected===b.dataset.build?null:b.dataset.build;render();return;}
            if(b.id==='open-trade'){root.classList.add('trading');$('#trade-from').focus();return;}
            let action=null;
            if(b.dataset.place!==undefined)action={type:'build',piece:state.phase.startsWith('setup')?state.phase.slice(6):state.phase==='free-road'?'road':selected,target:Number(b.dataset.place)};
            else if(b.dataset.tile!==undefined)action={type:'robber',target:Number(b.dataset.tile)};
            else if(b.dataset.discard)action={type:'discard',resource:b.dataset.discard};
            else if(b.dataset.steal!==undefined)action={type:'steal',target:Number(b.dataset.steal)};
            else if(b.id==='roll-dice')action={type:'roll'};
            else if(b.id==='end-turn')action={type:'end'};
            else if(b.dataset.specialBuildFlag!==undefined)action={type:'special-build-flag'};
            else if(b.id==='trade-button')action={type:'bank-trade',give:$('#trade-from').value,receive:$('#trade-to').value};
            else if(b.id==='buy-development')action={type:'buy-development'};
            else if(b.id==='offer-trade')action={type:'offer',give:Object.fromEntries(E.resources.map(r=>[r,Number($('#offer-give-'+r).value)])),want:Object.fromEntries(E.resources.map(r=>[r,Number($('#offer-want-'+r).value)]))};
            else if(b.dataset.offer)action={type:'accept-trade',offer:b.dataset.offer};
            else if(b.id==='cancel-trade')action={type:'cancel-trade'};
            else if(b.dataset.dev){
                devChoice=b.dataset.dev;devPicks=[];renderDevOptions();return;
            }else if(b.dataset.devPick){
                const limit=devChoice==='monopoly'?1:2;
                if(devPicks.length<limit)devPicks.push(b.dataset.devPick);
                renderDevOptions();return;
            }else if(b.id==='confirm-development'){
                const resources={};for(const r of devPicks)resources[r]=(resources[r]||0)+1;
                action={type:'play-development',card:devChoice,resource:devPicks[0],resources};
                devChoice=null;devPicks=[];renderDevOptions();
            }else if(b.id==='cancel-development'){devChoice=null;devPicks=[];renderDevOptions();return;}
            if(action)client.action(action);return;
        }
        const previousPhase=state.phase,previousPlayer=state.current,previousSetup=state.setup;
        const previousBuildings=Object.keys(state.buildings).length,previousRoads=Object.keys(state.roads).length;
        const previousCities=state.players[state.current].city;
        if(b.dataset.place!==undefined){const kind=state.phase.startsWith('setup')?state.phase.slice(6):selected;if(E.build(state,kind,Number(b.dataset.place)))selected=null;}
        else if(b.dataset.build){selected=selected===b.dataset.build?null:b.dataset.build;}
        else if(b.dataset.tile!==undefined)E.moveRobber(state,Number(b.dataset.tile));
        else if(b.dataset.discard)E.discard(state,b.dataset.discard);
        else if(b.dataset.steal!==undefined)E.steal(state,Number(b.dataset.steal));
        else if(b.id==='roll-dice'){E.roll(state);flashProduction();selected=null;}
        else if(b.id==='end-turn'){E.end(state);selected=null;}
        else if(b.id==='trade-button'){if(E.trade(state,$('#trade-from').value,$('#trade-to').value))sound.play('sfx_offer_accepted');}
        else if(b.id==='open-trade'){$('#trade-panel').scrollIntoView({behavior:'smooth',block:'center'});$('#trade-from').focus();return;}
        else if(b.id==='new-game'){if(!Object.keys(state.buildings).length||window.confirm('Start a new game? This will clear this local board.')){state=E.create(state.players.map(p=>p.name));selected=null;}}
        else return;
        if(state.winner!==null)sound.play('sfx_victory');
        else if(previousSetup===7&&state.setup===8)sound.play('sfx_settlement_phase_ended');
        else if(state.setup===0&&previousSetup>0)sound.play('sfx_game_started');
        else if(Object.keys(state.buildings).length>previousBuildings)sound.play('sfx_settlement_place');
        else if(Object.keys(state.roads).length>previousRoads)sound.play('sfx_road_place');
        else if(state.players[previousPlayer].city<previousCities)sound.play('sfx_city_place');
        else if(b.id==='roll-dice'&&previousPhase==='roll')sound.play(`sfx_dice_roll_${(state.dice[0]-1)%4+1}`);
        else if(b.dataset.tile!==undefined&&previousPhase==='robber')sound.play('sfx_robber_place');
        else if(b.dataset.discard)sound.play('sfx_discard_broadcast');
        else if(b.dataset.steal!==undefined)sound.play('sfx_click');
        else if(b.id==='end-turn'&&previousPhase==='build')sound.play('sfx_your_turn');
        else if(b.dataset.build)sound.play('sfx_click');
        render();
    });
    ['#trade-from','#trade-to'].forEach(id=>{$(id).innerHTML=E.resources.map(r=>`<option value="${r}">${r}</option>`).join('');$(id).addEventListener('change',updateTrade);});
    $('#trade-to').value='brick';render();
    if(client){
        client.subscribe(room=>{
            useGeometry(room.geometry);
            root.classList.toggle('base-six-mode',room.map==='base-56');
            if(!room.game){
                seat=room.seat;selected=null;devChoice=null;devPicks=[];renderDevOptions();
                state=E.create([0,1,2,3].map(i=>room.members.find(m=>m.seat===i)?.name||'Open seat'));
                state.phase='waiting';state.map=room.map||'base';state.legal={};state.deckCount=room.map==='base-56'?34:25;
                if(room.preview)E.tiles.splice(0,E.tiles.length,...room.preview);
                if(room.previewPorts)E.ports.splice(0,E.ports.length,...room.previewPorts);
                state.robber=E.tiles.find(t=>t.type==='desert').id;
                render();return;
            }
            if(room.id===lastRoomId&&room.gameRevision===lastGameRevision&&room.seat===lastViewSeat)return;
            const animateReceipt=room.id===lastRoomId&&room.seat===lastViewSeat;
            const offerSnapshot=room.id===lastRoomId&&lastGameRevision>=0;
            lastRoomId=room.id;lastGameRevision=room.gameRevision;lastViewSeat=room.seat;
            const previous=state,newEvent=lastVersion>=0&&room.version>lastVersion&&room.game.log?.length&&room.game.log.at(-1)!==previous.log?.at(-1);
            state=room.game;state.map ||= room.map||'base';seat=room.seat;selected=null;lastVersion=room.version;
            if(devChoice&&!state.players[seat]?.dev?.some(card=>card.kind===devChoice)){devChoice=null;devPicks=[];renderDevOptions();}
            if((state.rolls?.length||0)>(previous.rolls?.length||0))flashProduction();
            // Redacted hands stay unknown; zero-filled values are only for disabled UI checks.
            state.players.forEach(p=>{if(!p.resources)p.resources=Object.fromEntries(E.resources.map(r=>[r,0]));});
            E.tiles.splice(0,E.tiles.length,...state.tiles);E.ports.splice(0,E.ports.length,...state.ports);
            if(newEvent&&state.mode!=='cities-knights'){
                const log=state.log.at(-1),name=state.winner!==null?'sfx_victory':log.includes('placed a settlement')?'sfx_settlement_place':log.includes('placed a city')?'sfx_city_place':log.includes('placed a road')?'sfx_road_place':log.includes('rolled ')?'sfx_dice_roll_1':log.includes('moved the robber')?'sfx_robber_place':log.includes('bought a development')?'sfx_devcard_bought':log.includes('played ')?'sfx_devcard_used':log.includes('traded')||log.includes('completed a trade')?'sfx_offer_accepted':log.includes('declined a trade')?'sfx_offer_rejected':log.includes('accepted an offer')?'sfx_offer_acceptable':log.includes('ended their turn')?'sfx_your_turn':'sfx_click';sound.play(name);
            }
            render();
            if(animateReceipt)receivedCards(previous,state);
            if(offerSnapshot&&previous.offers?.length&&!state.offers?.length)root.classList.remove('trading');
            if(offerSnapshot&&seat!==null&&state.offers?.some(offer=>
                !previous.offers?.some(old=>old.id===offer.id)&&offer.author!==seat
            )&&(state.mode==='cities-knights'||['offered a trade','proposed a counteroffer'].some(event=>state.log?.at(-1)?.includes(event))))root.classList.add('trading');
            clearTimeout(tradeDeclineTimer);
            if(state.offers?.length&&state.offers.every(offer=>offer.allRejected))
                tradeDeclineTimer=setTimeout(()=>root.classList.remove('trading'),1500);
        });
    }
})();
