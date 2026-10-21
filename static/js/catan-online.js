/* Online transport: server snapshots are authoritative; no optimistic game moves. */
(() => {
    if(document.querySelector('.catan-app')?.dataset.online!=='true')return;
    const $=s=>document.querySelector(s), esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let csrf,room=null,roomId=new URLSearchParams(location.search).get('room'),busy=false,loading=false,tick=0,socket,pendingRoom=null,lobbyLoading=false;
    const subscribers=[];
    const modeLabel=(mode,map)=>`${mode==='cities-knights'?'Cities & Knights':'Base game'}${map==='base-56'?' · 5–6 player':''}`;
    const capacity=map=>map==='base-56'?6:4;
    const colors=['red','blue','orange','green','purple','white'];
    const colorValues=['#ec5144','#398de6','#f6a638','#49b86a','#9e61d4','#eef2f2'];
    const notice=text=>{$('#online-notice').textContent=text;};
    async function request(path,body){
        const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
        try{
            const response=await fetch('/api/catan'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json','X-Catan-CSRF':csrf}:{},body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store'});
            if(response.status===204)return null;
            const data=await response.json();
            if(!response.ok){if(data.closed){room=null;roomId=null;history.replaceState({},'','/games/catan');await lobby();}if(data.room)accept(data.room);throw new Error(data.error||'Could not reach the game.');}
            return data;
        }finally{clearTimeout(timeout);}
    }
    function accept(next){
        if(!next||next.id!==roomId||room&&next.version<room.version)return;
        const changed=!room||next.version!==room.version,statusChanged=!room||next.status!==room.status;
        const gameChanged=!room||room.mode!==next.mode||room.map!==next.map;
        room=next;
        if(statusChanged)$('#room-management').open=false;
        $('#online-rooms').hidden=true;$('#online-room').hidden=false;
        $('#back-lobby').hidden=false;
        document.querySelector('.catan-app').classList.toggle('waiting-room',room.status==='lobby');
        $('#online-title').textContent=room.name;
        $('#room-mode-label').textContent=modeLabel(room.mode,room.map);
        $('#room-members').innerHTML=room.members.map(m=>`<li>${profileAvatar(m.avatar).outerHTML}<div><strong>${esc(m.name)}${m.id===room.me?' (you)':''}</strong><small>${m.seat===null?'Spectator':colors[m.color??m.seat]+' seat'}${m.id===room.host?' · Host':''}${!m.online?' · Away':''}</small></div>${room.status==='lobby'&&m.seat!==null?`<span class="ready-tag ${m.ready?'is-ready':''}">${m.ready?'Ready':'Not ready'}</span>`:''}</li>`).join('');
        $('#room-phase-label').textContent={lobby:'Waiting',playing:'In progress',finished:'Finished'}[room.status];
        const me=room.members.find(m=>m.id===room.me),host=room.host===room.me;
        $('#ready-room').hidden=room.status!=='lobby'||room.seat===null;$('#ready-room').textContent=me.ready?'Not ready':'Ready';
        $('#start-room').hidden=!host||room.status!=='lobby';$('#start-room').disabled=room.members.filter(m=>m.seat!==null).length<3||room.members.some(m=>m.seat!==null&&!m.ready);
        $('#reshuffle-map').hidden=!host||room.status!=='lobby';
        $('#rematch-room').hidden=!host||room.status!=='finished';$('#claim-host').hidden=!room.canClaimHost||host;
        $('#close-abandoned').hidden=!host||room.status!=='playing';
        $('#return-room-lobby').hidden=!host||room.status==='lobby';
        $('#catan-change-game').hidden=!host||room.status!=='lobby';
        if(gameChanged||statusChanged){$('#catan-next-mode').value=room.mode;$('#catan-next-map').value=room.map;}
        $('#catan-next-map').disabled=room.testMode;
        $('#seat-options').hidden=room.status!=='lobby'||room.testMode;
        $('#test-seat-options').hidden=!room.testMode;
        $('#test-seat-options').innerHTML=room.testMode?'Control player: '+Array.from({length:room.map==='base-56'?5:3},(_,seat)=>`<button data-test-seat="${seat}" ${room.seat===seat?'disabled':''}>${colors[seat]}</button>`).join(''):'';
        $('#seat-options').innerHTML=[...Array.from({length:capacity(room.map)},(_,seat)=>seat),null].map(seat=>`<button data-seat="${seat===null?'spectator':seat}" ${room.seat===seat||seat!==null&&room.members.some(m=>m.seat===seat)?'disabled':''}>${seat===null?'Spectate':colors[seat]}</button>`).join('');
        $('.catan-layout').hidden=false;
        $('.room-status').textContent=`${room.status==='lobby'?'WAITING FOR PLAYERS':room.status==='playing'?'GAME IN PROGRESS':'GAME FINISHED'} · ${room.members.filter(m=>m.seat!==null).length}/${capacity(room.map)}`;
        const historyLog=$('#room-history'),moves=(room.game?.log||[]).join('\n');
        if(historyLog.textContent!==moves){const atBottom=historyLog.scrollHeight-historyLog.scrollTop-historyLog.clientHeight<30;historyLog.textContent=moves;if(atBottom)historyLog.scrollTop=historyLog.scrollHeight;}
        const chat=JSON.stringify(room.chat),log=$('#room-chat');
        if(log.dataset.messages!==chat){const atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<30;log.replaceChildren();room.chat.forEach(m=>renderProfileMessage(log,m.name,m.text,m.avatar));if(!room.chat.length)log.textContent='No messages yet. Say hello to the room.';log.dataset.messages=chat;if(atBottom)log.scrollTop=log.scrollHeight;}
        $('#online-help').textContent=room.game?'Progress is saved. Refresh or reconnect to return to your seat.':'Choose a seat and ready up. The host starts when at least three players are ready.';
        if(changed)subscribers.forEach(fn=>fn(room));
    }
    async function refresh(force=false){
        if(!roomId||loading||busy)return;
        loading=true;
        try{accept(await request('/rooms/'+roomId+(!force&&room?'?version='+room.version:'')));notice('Connected · progress saved');}
        catch(e){notice(e.name==='AbortError'?'Connection slow. Reconnecting…':e.message+(roomId?' Reconnecting…':''));}
        finally{loading=false;}
    }
    async function action(data){
        if(busy||!roomId)return false;
        busy=true;notice('Saving…');
        const command={...data,command:crypto.randomUUID(),version:room?.version,gameRevision:room?.gameRevision};
        try{
            let result;
            // One retry of the SAME command makes a lost acknowledgement safe.
            try{result=await request('/rooms/'+roomId+'/actions',command);}
            catch(e){if(e.name==='AbortError'||e instanceof TypeError)result=await request('/rooms/'+roomId+'/actions',command);else throw e;}
            if(result.left){room=null;roomId=null;history.pushState({},'','/games/catan');await lobby();}
            else accept(result);
            notice('Connected · progress saved');
            return true;
        }catch(e){notice(e.message||'Connection lost. Reconnecting…');return false;}
        finally{busy=false;}
    }
    async function join(id,spectator=false){
        roomId=id;room=null;history.pushState({},'','/games/catan?room='+encodeURIComponent(id));
        await action({type:'join',spectator});
        if(room)socket?.emit('watch',{id:roomId});
    }
    async function lobby(){
        if(lobbyLoading)return;lobbyLoading=true;
        try{
        const data=await request('/lobby');csrf=data.csrf;
        $('#test-room').disabled=!data.testRooms;
        $('#test-room').title=data.testRooms?'':'Available after the game server update is activated.';
        const cards=data.rooms.map(r=>{
            const players=r.members.filter(m=>m.seat!==null),spectators=r.members.filter(m=>m.seat===null);
            const status={lobby:r.seats<capacity(r.map)?'Waiting for players':'Full · Waiting',playing:'Game in progress',finished:'Finished'}[r.status];
            return `<article class="room-card" data-room-card="${esc(r.id)}"><div class="room-poster catan-room-poster"><img src="/static/assets/catan/colonist/terrain-wood.svg" alt=""><img src="/static/assets/catan/colonist/terrain-wheat.svg" alt=""><img src="/static/assets/catan/colonist/terrain-brick.svg" alt=""><span class="live-badge">${status}</span></div><div class="room-info"><h2 class="room-name">${esc(r.name)}</h2><p class="now-playing">${esc(modeLabel(r.mode,r.map))} · ${r.seats}/${capacity(r.map)} players · ${r.spectators} spectator${r.spectators===1?'':'s'}</p><div class="listed-players">${players.map(m=>`<span class="listed-person">${profileAvatar(m.avatar).outerHTML}${esc(m.name)}${m.online?'':' <small>(away)</small>'}</span>`).join('')||'<span>Seats available</span>'}</div>${spectators.length?`<p class="listed-spectators">Watching: ${spectators.map(m=>esc(m.name)).join(', ')}</p>`:''}<div class="room-users">Hosted by ${esc(r.host)}</div><div class="card-actions">${r.mine?`<button class="btn-submit" data-room="${esc(r.id)}" data-role="resume">Return to room</button>`:`<button class="btn-submit" data-room="${esc(r.id)}" data-role="play" ${r.status!=='lobby'||r.seats>=capacity(r.map)?'disabled':''}>Join to play</button><button class="btn-cancel" data-room="${esc(r.id)}" data-role="spectate">Spectate</button>`}</div></div></article>`;
        }).join('')||'<div class="no-rooms"><h2>No open games yet</h2><p>Create a room to start a game.</p></div>';
        if($('#room-list').innerHTML!==cards)$('#room-list').innerHTML=cards;
        if(!roomId){$('#online-rooms').hidden=false;$('#online-room').hidden=true;$('.catan-layout').hidden=true;$('#back-lobby').hidden=true;$('.room-status').textContent='ONLINE · OPEN GAMES';}
        }finally{lobbyLoading=false;}
    }
    window.CatanClient={get room(){return room;},get busy(){return busy;},action,subscribe(fn){subscribers.push(fn);if(room)fn(room);}};
    $('.catan-app').addEventListener('click',async event=>{
        const b=event.target.closest('button');if(!b||b.disabled||busy)return;
        try{
            if(b.id==='back-lobby'){roomId=null;room=null;history.pushState({},'','/games/catan');await lobby();}
            else if(b.id==='open-create-room'){$('#create-room-dialog').showModal();$('#create-room-title').focus();}
            else if(b.id==='cancel-create-room')$('#create-room-dialog').close();
            else if(b.id==='choose-play'||b.id==='choose-spectate'){$('#join-choice').close();await join(pendingRoom,b.id==='choose-spectate');}
            else if(b.id==='cancel-join'){$('#join-choice').close();roomId=null;history.replaceState({},'','/games/catan');await lobby();}
            else if(b.dataset.room)await join(b.dataset.room,b.dataset.role==='spectate');
            else if(b.dataset.testSeat!==undefined)await action({type:'test-seat',seat:Number(b.dataset.testSeat)});
            else if(b.dataset.seat!==undefined)await action({type:'seat',seat:b.dataset.seat==='spectator'?null:Number(b.dataset.seat)});
            else if(b.id==='ready-room')await action({type:'ready'});
            else if(b.id==='start-room')await action({type:'start'});
            else if(b.id==='reshuffle-map')await action({type:'reshuffle-map'});
            else if(b.id==='rematch-room')await action({type:'rematch'});
            else if(b.id==='return-room-lobby')await action({type:'return-lobby'});
            else if(b.id==='claim-host')await action({type:'claim-host'});
            else if(b.id==='close-abandoned')await action({type:'end-abandoned'});
            else if(b.id==='leave-room'&&confirm(room.status==='playing'&&room.seat!==null?'Resigning ends this match for all players. Leave?':'Leave this room?'))await action({type:'leave'});
            else if(b.id==='refresh-rooms')await lobby();
        }catch(e){notice(e.message);}
    });
    $('#catan-change-game').addEventListener('submit',async event=>{
        event.preventDefault();await action({type:'change-game',mode:$('#catan-next-mode').value,map:$('#catan-next-map').value});
    });
    $('#create-room-form').addEventListener('submit',async event=>{
        event.preventDefault();if(busy)return;busy=true;$('#create-room').disabled=true;
        try{
            const result=await request('/rooms',{name:$('#room-name').value,mode:document.querySelector('input[name="game-mode"]:checked').value,map:document.querySelector('input[name="game-map"]:checked').value,public:true,testMode:$('#test-room').checked});
            roomId=result.id;room=null;history.pushState({},'','/games/catan?room='+roomId);$('#create-room-dialog').close();accept(result);socket?.emit('watch',{id:roomId});
        }catch(e){$('#create-room-dialog').close();notice(e.message);}
        finally{busy=false;$('#create-room').disabled=false;}
    });
    $('#join-choice').addEventListener('cancel',()=>{roomId=null;history.replaceState({},'','/games/catan');lobby().catch(e=>notice(e.message));});
    $('#chat-form').addEventListener('submit',async e=>{e.preventDefault();const input=$('#chat-message'),message=input.value;if(message.trim()&&!busy){if(await action({type:'chat',message})&&input.value===message)input.value='';}});
    window.addEventListener('online',()=>refresh(true));
    window.addEventListener('popstate',()=>location.reload());
    async function init(){
        try{
            await lobby();
            if(typeof io==='function'){
                socket=io('/catan');socket.on('connect',()=>{if(roomId){socket.emit('watch',{id:roomId});refresh(true);}});
                socket.on('changed',data=>{if(data.id===roomId)refresh();});
            }
            if(roomId){
                const info=await request('/rooms/'+roomId+'/info');
                if(info.mine)await join(roomId);
                else{pendingRoom=roomId;$('#join-choice-title').textContent=info.name;$('#join-choice-description').textContent=`${info.seats}/${capacity(info.map)} player seats filled. ${info.status==='playing'?'The game has started; you can watch and chat.':'Choose how you want to join.'}`;$('#choose-play').disabled=info.status!=='lobby'||info.seats>=capacity(info.map);$('#join-choice').showModal();}
            }
            notice('Connected');
        }catch(e){notice(e.message);}
        // Polling also recovers missed notifications and works when sockets are unavailable.
        setInterval(()=>{tick++;if(roomId&&room)refresh(tick%8===0);else if(!document.hidden&&!roomId&&tick%3===0)lobby().catch(e=>notice(e.message));},2000);
        document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(true);});
    }
    init();
})();
