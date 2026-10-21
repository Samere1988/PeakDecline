(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const catalog = JSON.parse($('retro-catalog').textContent);
    const browser = $('retro-room-browser'), lobby = $('retro-lobby');
    const dialog = $('retro-create-dialog'), createButton = $('retro-room-create');
    const browserNotice = $('retro-browser-notice'), lobbyNotice = $('retro-room-status');
    const startButton = $('retro-start-race');
    let socket, code, memberId, hostId, slot, role, players, game, network, started = false;
    let resumeToken, telemetry;
    let awaitingResume = false, resumeTimer;
    let adapter, launchGeneration = 0, didLaunch = false;
    let currentRoom, stopBroadcast, shutdown = Promise.resolve(), returning = false;
    let interruptionReport;
    let invite = new URLSearchParams(location.search).get('room')?.toUpperCase();
    function saveResume(roomCode,token,gameId=game?.id) {
        try { sessionStorage.setItem('retro-resume:'+roomCode,token); } catch {}
        if (['mk64','marioparty','marioparty2'].includes(gameId)) {
            try { localStorage.setItem('retro-party-resume:'+roomCode,token); } catch {}
        }
    }
    function readResume(roomCode) {
        try { const token=sessionStorage.getItem('retro-resume:'+roomCode); if(token)return token; } catch {}
        try { return localStorage.getItem('retro-party-resume:'+roomCode); } catch { return null; }
    }
    const roundTrips = [];
    const retainedLockstep = () => ['mk64', 'marioparty', 'marioparty2'].includes(game?.id) && game.backend === 'recomp-ring-lockstep-v1';
    const canRetain = () => typeof network?.suspendTransport === 'function' && (['authoritative-host-v1','sync-input-v1','mk64-server-authority-v1'].includes(game?.backend) ||
        retainedLockstep());
    function probeLatency() {
        if (!socket?.connected) return;
        const at = performance.now();
        socket.timeout(1500).emit('latency_probe', error => {
            telemetry?.latency(error ? null : performance.now()-at);
            if (error) return;
            roundTrips.push(performance.now() - at);
            if (roundTrips.length > 8) roundTrips.shift();
            network?.latency(game?.id === 'mk64' ? roundTrips[roundTrips.length - 1] : Math.max(...roundTrips));
        });
    }
    function joinRoom(room) {
        const local = catalog.find(entry => entry.id === room.game.id);
        if (!local?.available || local.build !== room.game.build) {
            browserNotice.textContent = 'This room uses a different game build. Reload the page.';
            return;
        }
        const token=readResume(room.code);
        if(room.phase==='running' && (['authoritative-host-v1','sync-input-v1','mk64-server-authority-v1'].includes(local.backend) || ['marioparty','marioparty2'].includes(local.id)) && token)
            connect().emit('resume',{code:room.code,token,compatibility:local,retained:false});
        else connect().emit('join', {code: room.code, compatibility: local});
    }

    // Shared room presentation is inserted below; game rendering stays in its adapter.
    function roomDetails(raw) {
        const members = (Array.isArray(raw?.members) ? raw.members : []).map((member, index) =>
            typeof member === 'object' && member !== null ? {
                ...member, id: member.id ?? member.sid ?? String(index), name: member.name || `Guest ${index + 1}`,
                role: ['player', 'spectator'].includes(member.role) ? member.role : 'undecided', ready: member.ready === true
            } : {id: String(index), name: String(member), role: 'undecided', ready: false});
        const playing = Number.isInteger(raw?.playing) ? raw.playing : members.filter(member => member.role === 'player').length;
        const ready = Number.isInteger(raw?.ready) ? raw.ready : members.filter(member => member.role === 'player' && member.ready).length;
        return {...raw, members, playing, ready, joined: members.length,
            spectators: members.filter(member => member.role === 'spectator').length,
            choosing: members.filter(member => member.role === 'undecided').length};
    }
    function artwork(element, game) {
        element.dataset.game = game.id;
        element.textContent = '';
        element.setAttribute('role', 'img');
        element.setAttribute('aria-label', `${game.title} title screen`);
    }
    function occupancy(room) {
        const parts = [`${room.playing}/${room.maxPlayers} players`, `${room.ready} ready`];
        if (room.spectators) parts.push(`${room.spectators} spectating`);
        if (room.choosing) parts.push(`${room.choosing} choosing`);
        return parts.join(' · ');
    }
    function memberTitle(member) {
        const title = document.createElement('strong');
        title.textContent = member.name;
        if (member.id === hostId) {
            const badge = document.createElement('span');
            badge.className = 'mk64-host-badge'; badge.textContent = '👑';
            badge.setAttribute('role', 'img'); badge.setAttribute('aria-label', 'Host');
            title.append(badge);
        }
        return title;
    }

    function notice(message) { (started ? $('retro-runtime-status') : code ? lobbyNotice : browserNotice).textContent = message; }
    function clearRoom() {
        returning = false;
        interruptionReport = undefined;
        $('retro-interruption').hidden = true;
        if(code) { try { sessionStorage.removeItem('retro-resume:'+code); localStorage.removeItem('retro-party-resume:'+code); } catch {} }
        resumeToken = undefined;
        code = undefined; memberId = undefined; hostId = undefined; slot = undefined; role = undefined; players = undefined; started = false; network = undefined;
        lobby.hidden = true; browser.hidden = false;
        $('retro-back-rooms').hidden = true;
        $('retro-close-game').hidden = true;
        $('retro-return').hidden = true;
        currentRoom = undefined;
        $('retro-open-create').disabled = false;
        history.replaceState({}, '', location.pathname);
        if (socket?.connected) socket.emit('list');
    }
    function renderRooms(rawRooms) {
        const rooms = Array.isArray(rawRooms) ? rawRooms.map(roomDetails) : [];
        const list = $('retro-room-list');
        list.replaceChildren();
        browserNotice.textContent = rooms.length ? `${rooms.length} open ${rooms.length === 1 ? 'lobby' : 'lobbies'}` : 'No open lobbies yet. Create one to get started.';
        if (!rooms.length) {
            const empty = document.createElement('div');
            empty.className = 'no-rooms';
            const title = document.createElement('h2');
            title.textContent = 'No active rooms';
            const description = document.createElement('p');
            description.textContent = 'Click “+ Create Room” to host a game.';
            empty.append(title, description); list.append(empty); return;
        }
        for (const room of rooms) {
            const card = document.createElement('article'); card.className = 'room-card';
            const poster = document.createElement('div'); poster.className = 'room-poster retro-game-art';
            artwork(poster, room.game);
            const badge = document.createElement('span'); badge.className = 'live-badge';
            badge.textContent = occupancy(room);
            poster.append(badge);
            const info = document.createElement('div'); info.className = 'room-info';
            const name = document.createElement('h2'); name.className = 'room-name'; name.textContent = room.name || 'Game room';
            const description = document.createElement('p'); description.className = 'now-playing';
            description.textContent = `${room.game.title} · ${room.phase === 'running' ? 'Game in progress' : room.phase === 'loading' ? 'Game loading' : room.phase === 'ended' ? 'Round ended' : `${room.ready}/${room.playing} players ready`}`;
            const host = document.createElement('div'); host.className = 'room-users';
            const hostName = room.members.find(member => member.id === room.host)?.name || 'Host';
            const hostMember = room.members.find(member => member.id === room.host);
            host.append(profileAvatar(hostMember?.avatar), document.createTextNode(`Hosted by ${hostName}`));
            const roster = document.createElement('div'); roster.className = 'listed-players';
            room.members.filter(member => member.id !== room.host).forEach(member => {
                const person = document.createElement('span'); person.className = 'listed-person';
                person.append(profileAvatar(member.avatar), document.createTextNode(member.name));
                roster.append(person);
            });
            const actions = document.createElement('div'); actions.className = 'card-actions';
            const join = document.createElement('button'); join.className = 'mk64-primary'; join.type = 'button';
            const ownRoom = room.code === code;
            const canRejoin = room.phase === 'running' && ['marioparty','marioparty2'].includes(room.game.id) && readResume(room.code);
            join.textContent = ownRoom ? 'Return to room' : canRejoin ? 'Rejoin match' : ['running', 'loading'].includes(room.phase) ? 'Spectate' : 'Join room';
            join.disabled = !ownRoom && (room.joined >= 20 || !room.code || !!code);
            join.addEventListener('click', () => {
                if (ownRoom) {
                    browser.hidden = true; lobby.hidden = false; $('retro-back-rooms').hidden = false;
                } else joinRoom(room);
            });
            actions.append(join);
            info.append(name, description);
            if (roster.children.length) info.append(roster);
            info.append(host, actions); card.append(poster, info); list.append(card);
        }
    }
    function renderLobby(raw) {
        const room = roomDetails(raw);
        if (room.code !== code) return;
        currentRoom = room;
        players = room.players;
        game = room.game;
        $('retro-settings-summary').textContent = (game.settings || []).map(field => {
            const selected = field.choices.find(choice => choice.value === room.settings?.[field.key]);
            return field.label + ': ' + (selected?.label || '—');
        }).join(' · ');
        $('retro-game-title').textContent = game.title + ' lobby';
        artwork($('retro-lobby-art'), game);
        $('retro-invite').value = location.origin + location.pathname + '?room=' + code;
        hostId = room.host;
        const me = room.members.find(member => member.id === memberId);
        slot = me?.slot;
        role = me?.role;
        $('retro-lobby-title').textContent = room.name || 'Game room';
        $('retro-lobby-count').textContent = occupancy(room);
        const controllerArea=$('retro-controller-setup');
        if(controllerArea){
            if(controllerArea.dataset.game!==game.id){controllerArea.replaceChildren();controllerArea.dataset.game=game.id;}
            controllerArea.hidden=typeof PeakNet.adapters.get(game.adapter)?.lobby!=='function';
            PeakNet.adapters.get(game.adapter)?.lobby?.({role});
        }
        const compatible = room.schemaVersion === 1;
        const choosing = compatible && room.phase === 'lobby' && !returning;
        document.querySelector('.mk64-phase').textContent = !compatible ? 'Updating room' : room.phase === 'ended' ? 'Round ended' : room.phase !== 'lobby' ? 'Game in progress' : room.playing >= 1 && room.ready === room.playing && !room.choosing ? 'Ready to start' : 'Choosing roles';
        $('retro-seat-count').textContent = `${room.playing}/${room.maxPlayers} seats`;
        const list = $('retro-room-members'); list.replaceChildren();
        for (let seat = 0; seat < room.maxPlayers; seat++) {
            const member = room.members.find(entry => entry.role === 'player' && entry.slot === seat);
            const row = document.createElement('li');
            const avatar = document.createElement('span'); avatar.className = `mk64-seat-avatar${member ? '' : ' empty'}`;
            avatar.textContent = member ? member.name.slice(0, 1).toUpperCase() : `${seat + 1}`;
            const identity = document.createElement('div'); identity.className = 'mk64-seat-name';
            const title = member ? memberTitle(member) : document.createElement('strong');
            if (!member) title.textContent = 'Waiting for player';
            const detail = document.createElement('small'); detail.textContent = `Seat ${seat + 1}${member?.id === memberId ? ' · You' : ''}`;
            identity.append(title, detail); row.append(member ? profileAvatar(member.avatar) : avatar, identity);
            if (member) {
                const readyState = document.createElement('div'); readyState.className = 'mk64-ready-state';
                const marker = member.id === memberId ? document.createElement('button') : document.createElement('span');
                marker.className = `mk64-ready-marker${member.ready ? ' is-ready' : ''}`;
                marker.textContent = '✓';
                if (member.id === memberId) {
                    marker.id = 'retro-ready'; marker.type = 'button';
                    marker.disabled = !choosing;
                    marker.setAttribute('aria-label', member.ready ? 'Cancel ready' : 'Mark ready');
                    marker.setAttribute('aria-pressed', String(member.ready));
                    marker.addEventListener('click', () => {
                        if (code && !started && role === 'player') connect().emit('ready', {ready: !member.ready});
                    });
                } else marker.setAttribute('aria-hidden', 'true');
                const tag = document.createElement('span'); tag.className = 'mk64-seat-tag';
                tag.textContent = member.ready ? 'Ready' : 'Not ready';
                readyState.append(marker, tag); row.append(readyState);
            }
            list.append(row);
        }
        const watchers = $('retro-spectator-members'); watchers.replaceChildren();
        for (const member of room.members.filter(entry => entry.role !== 'player')) {
            const item = document.createElement('li');
            const identity = document.createElement('div'); identity.className = 'mk64-seat-name';
            const detail = document.createElement('small');
            detail.textContent = `${member.role === 'spectator' ? 'Watching' : 'Choosing a role'}${member.id === memberId ? ' · You' : ''}`;
            identity.append(memberTitle(member), detail);
            item.append(profileAvatar(member.avatar), identity);
            watchers.append(item);
        }
        if (!watchers.children.length) { const item = document.createElement('li'); item.className = 'mk64-empty-spectators'; item.textContent = 'No spectators yet'; watchers.append(item); }
        const isHost = memberId === room.host;
        $('retro-change-game').hidden = !isHost || room.phase !== 'lobby';
        if ($('retro-change-game').dataset.game !== game.id || $('retro-change-game').dataset.epoch !== String(room.epoch)) {
            $('retro-change-game').dataset.game = game.id;
            $('retro-change-game').dataset.epoch = String(room.epoch);
            $('retro-next-game').value = game.id;
            renderSettings('retro-next-game', 'retro-next-settings', room.settings);
        }
        $('retro-apply-game').disabled = !choosing;
        $('retro-close-game').hidden = !isHost || room.phase === 'lobby';
        $('retro-close-game').disabled = returning;
        $('retro-choose-player').setAttribute('aria-pressed', String(role === 'player'));
        $('retro-choose-player').disabled = !choosing || role !== 'player' && room.playing >= room.maxPlayers;
        $('retro-choose-spectator').setAttribute('aria-pressed', String(role === 'spectator'));
        $('retro-choose-spectator').disabled = !choosing;
        startButton.hidden = !isHost || room.phase !== 'lobby';
        startButton.disabled = !choosing || room.playing < 1 || room.ready !== room.playing || room.choosing > 0;
        lobbyNotice.textContent = compatible && (game.backend === 'solo-media-v1' || ['marioparty', 'marioparty2'].includes(game.id)) ? '' : compatible ? 'Play solo or with friends. Mark ready, then start; spectators do not need a player seat.' : 'This room is using an older server version. Restart the Peak Decline app to enable player and spectator roles.';
    }
    function enterRoom(room) {
        if (!room?.code) { notice('The room could not be opened. Try again.'); return; }
        code = room.code; memberId = room.memberId; players = room.players;
        resumeToken=room.resumeToken; if(resumeToken)saveResume(code,resumeToken,room.game.id);
        probeLatency();
        history.replaceState({}, '', location.pathname + '?room=' + code);
        browser.hidden = true; lobby.hidden = false; $('retro-back-rooms').hidden = false;
        $('retro-open-create').disabled = true;
        if (dialog.open) dialog.close(); createButton.disabled = false;
        renderLobby(room);
    }


    function disposeRuntime() {
        ++launchGeneration;
        // A broken game destructor must not prevent the iframe and room UI
        // from being released. Attempt each independent cleanup operation.
        let failure;
        const clean = action => { try { action(); } catch (error) { failure ??= error; } };
        clean(() => stopBroadcast?.()); stopBroadcast = undefined;
        awaitingResume = false; clearTimeout(resumeTimer);
        clean(() => telemetry?.stop()); telemetry = undefined;
        clean(() => network?.dispose()); network = undefined; window.retroNetplay = undefined;
        const ending = adapter; adapter = undefined;
        shutdown = shutdown.catch(() => {}).then(() => ending?.stop()).then(() => { if (failure) throw failure; });
        return shutdown;
    }
    async function returnToLobby(room) {
        if (room.code !== code || room.epoch < currentRoom?.epoch ||
            room.epoch === currentRoom?.epoch && (returning || !started && currentRoom.phase === 'lobby')) return;
        if (['desync', 'runtime_failure', 'player_left'].includes(room.interruption?.reason)) {
            let diagnostics;
            try { diagnostics = network?.diagnostics?.(); } catch {}
            // Keep a detached, bounded report before dispose clears history.
            // No room/member identifiers, controller inputs or game snapshots.
            interruptionReport = JSON.parse(JSON.stringify({schemaVersion: 1,
                recordedAt: new Date().toISOString(), game: {id: game.id, build: game.build,
                    protocol: game.protocol, backend: game.backend},
                ...room.interruption, slot, spectator: role === 'spectator',
                rollbackCount: network?.engine?.rollbacks ?? 0, diagnostics}));
            $('retro-interruption').hidden = false;
            const explanation = {desync: 'The players’ game states stopped matching.',
                runtime_failure: 'A player’s game could not continue.', player_left: 'A player left or lost their connection.'}[room.interruption.reason];
            $('retro-interruption-message').textContent = explanation + ' You’re back in the same lobby. Mark ready to start another match.';
        }
        currentRoom = room; returning = true;
        $('retro-close-game').hidden = true;
        $('retro-return').hidden = true;
        $('retro-runtime-status').textContent = 'Returning to the lobby…';
        let failure;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        const stopping = disposeRuntime(), generation = launchGeneration;
        try { await stopping; } catch (error) { failure = error.message; }
        if (room.code !== code || generation !== launchGeneration) return;
        if (failure && interruptionReport) interruptionReport.cleanupError = failure;
        returning = false; started = false;
        browser.hidden = true; lobby.hidden = false; $('retro-back-rooms').hidden = false;
        $('retro-runtime-status').textContent = failure || '';
        renderLobby(currentRoom);
        if (interruptionReport) $('retro-interruption-message').focus();
    }
    function stopNetwork(message) {
        // Preserve the local loading error when the server broadcasts a generic stop.
        message = network?.failureMessage || message;
        disposeRuntime().catch(error => { $('retro-runtime-status').textContent = error.message; });
        $('retro-runtime-status').textContent = message;
        $('retro-return').hidden = false;
    }
    async function prepare(event) {
        if (event.code !== code) return;
        if (event.code !== code || currentRoom?.phase === 'lobby' && event.epoch < currentRoom.epoch) return;
        const stopping = disposeRuntime(), generation = launchGeneration;
        returning = false;
        interruptionReport = undefined;
        $('retro-interruption').hidden = true;
        game = event.game;
        const me = event.members.find(person => person.id === memberId);
        role = me.role; slot = me.slot; players = event.players; hostId = event.host;
        started = true;
        currentRoom = event;
        browser.hidden = true; lobby.hidden = true;
        $('retro-back-rooms').hidden = true;
        $('retro-runtime-status').textContent = game.backend === 'mk64-server-authority-v1'
            ? 'Loading your game…' : 'Loading the game for everyone…';
        $('retro-return').hidden = false;
        $('retro-close-game').hidden = memberId !== hostId;
        $('retro-close-game').disabled = false;
        try {
            await stopping;
            if (generation !== launchGeneration) return;
            const media = me.watchMode === 'media' || (me.role === 'spectator' && PeakNet.SpectatorStream.videoBackends.has(event.game.backend));
            const Backend = PeakNet.backends.get(media ? 'spectator-media-v1' : game.backend);
            if (!Backend) throw new Error('This game networking mode is unavailable.');
            const pending = await Backend.create({socket, game, epoch: event.epoch, players, slot,
                coreUrl: $('retro-catalog').dataset.coreUrl, seed:event.seed,
                spectator: role === 'spectator', recovery:event.recovery, resumeSequence: event.resumeSequence, onFailure: stopNetwork});
            if (generation !== launchGeneration) { pending.dispose(); return; }
            network = pending;
            if (game.id === 'mk64' && roundTrips.length) network.latency?.(Math.max(...roundTrips));
            telemetry=PeakNet.Telemetry?.start(network);
            window.retroNetplay = network;
            adapter = PeakNet.adapters.get(media ? 'spectator-media' : game.adapter);
            if (!adapter) throw new Error('This game adapter is unavailable.');
            adapter.present({name: event.name, spectator: role === 'spectator', requestRestart: () => {
                if (!network?.running || network.failed || memberId !== hostId) return false;
                socket.emit('restart_game'); return true;
            }});
            const session = network;
            stopBroadcast = PeakNet.publishSpectators(session, adapter, event);
            await adapter.launch({session, initialSave:event.initialSave, seed:event.seed, slot: slot ?? 0, players,
                canRestart: memberId === hostId, restart: didLaunch, settings: event.settings || {}});
            didLaunch = true;
            if (generation !== launchGeneration) {
                return;
            }
            if (!session.running) $('retro-runtime-status').textContent = 'Waiting for everyone to finish loading…';
        } catch (error) {
            if (generation !== launchGeneration) return;
            socket.emit('failed', {epoch: event.epoch, message:String(error.message||error).slice(0,240)});
            stopNetwork(error.message || 'Could not load the game.');
        }
    }
    function connect() {
        if (socket) return socket;
        socket = io('/retro');
        setInterval(probeLatency, 2000);
        socket.on('connect', () => {
            if(code && resumeToken && canRetain() && network && !network.failed) {
                awaitingResume = retainedLockstep();
                socket.emit('resume',{code,token:resumeToken,compatibility:game,retained:game.backend === 'mk64-server-authority-v1' ? false : !network.rebuilding,
                    ...(retainedLockstep() ? {epoch:network.epoch,frame:network.frame - 1} : {})});
            } else socket.emit('list');
            probeLatency();
        });
        socket.on('connect_error', () => { browserNotice.textContent = 'Could not connect. Sign in or reload the page to try again.'; });
        socket.on('rooms', rooms => {
            renderRooms(rooms);
            if (invite && !code) {
                const target = rooms.find(room => room.code === invite);
                invite = null;
                if (target) joinRoom(target);
                else browserNotice.textContent = 'That invite is unavailable. Choose an open lobby or create one.';
            }
        });
        socket.on('room', enterRoom);
        socket.on('room_update', room => {
            if (room.code !== code) return;
            currentRoom = room;
            if (returning) return;
            if (!started) renderLobby(room);
            else {
                hostId = room.host;
                $('retro-close-game').hidden = memberId !== hostId || room.phase === 'lobby';
                adapter?.hostChanged?.(memberId === hostId);
            }
        });
        socket.on('lobby_returned', returnToLobby);
        socket.on('room_error', event => {
            createButton.disabled = false;
            if (awaitingResume) stopNetwork(event.message);
            else notice(event.message);
        });
        socket.on('prepare', prepare);
        socket.on('start', event => {
            if (network && event.epoch === network.epoch) {
                network.start();
                if(event.paused && !network.rebuilding) network.suspendTransport?.();
                $('retro-runtime-status').textContent = network.rebuilding ? 'Restoring your match…' : event.paused ? 'Waiting for the host to reconnect…' :
                    role === 'spectator' ? 'Watching the game.' : 'Connected. The game is ready.';
            }
        });
        socket.on('party_history', event => network?.receiveReplay?.(event));
        socket.on('party_live', event => {
            network?.replayLive?.(event);
            if (event.epoch === network?.epoch)
                $('retro-runtime-status').textContent = event.paused ? 'Waiting for another player to rejoin…' : 'Your match is restored.';
        });
        socket.on('frameset', event => network?.receive?.(event));
        socket.on('frame_input', event => network?.receiveInput?.(event));
        socket.on('fps_command', event => network?.receiveCommand?.(event));
        socket.on('world_snapshot', event => network?.receiveSnapshot?.(event));
        socket.on('sync_frames',event=>network?.receive?.(event));
        socket.on('sync_history',event=>network?.receive?.(event,true));
        socket.on('sync_live',event=>network?.receiveLive?.(event));
        socket.on('sync_resumed',event=>{
            if(event.code!==code||event.epoch!==network?.epoch)return;
            memberId=event.memberId;hostId=event.host;resumeToken=event.resumeToken;saveResume(code,resumeToken);
            network.resumeTransport(event);adapter?.hostChanged?.(memberId===hostId);
            $('retro-runtime-status').textContent='Catching up with the game…';
        });
        socket.on('world_bootstrap', event => network?.receiveBootstrap?.(event));
        socket.on('world_recovery', event => network?.receiveRecovery?.(event));
        socket.on('resumed',event=>{
            if(event.code!==code || event.epoch!==network?.epoch)return;
            awaitingResume = false; clearTimeout(resumeTimer);
            memberId=event.memberId;hostId=event.host;resumeToken=event.resumeToken;saveResume(code,resumeToken);
            network.resumeTransport?.(event);
            adapter?.hostChanged?.(memberId===hostId);
            $('retro-runtime-status').textContent=network.failed?'Could not recover the connection.':
                event.paused?'Waiting for another player to reconnect…':'Reconnected to the game.';
        });
        socket.on('transport_paused',event=>{
            if(event.epoch!==network?.epoch)return;
            if (!network.rebuilding) network.suspendTransport?.();$('retro-runtime-status').textContent=retainedLockstep()?'Waiting for a player to rejoin…':'Waiting for the host to reconnect…';
        });
        socket.on('transport_resumed',event=>{
            if(event.epoch!==network?.epoch)return;
            network.resumeTransport?.(event);$('retro-runtime-status').textContent='Connected. The game continues.';
        });
        socket.on('stopped', event => {
            if (event.epoch === (network?.epoch ?? currentRoom?.epoch) && currentRoom?.phase !== 'lobby')
                stopNetwork(event.message);
        });
        socket.on('disconnect', () => {
            if(code && resumeToken && canRetain() && network && !network.failed) {
                network.suspendTransport();$('retro-runtime-status').textContent='Reconnecting to the game…';
                if (game.id === 'mk64') {
                    clearTimeout(resumeTimer);
                    resumeTimer=setTimeout(()=>stopNetwork('The reconnect window expired. Return to lobbies to start another race.'),18000);
                }
            } else if (code || started) stopNetwork('Connection lost. Return to lobbies to reconnect.');
            else browserNotice.textContent = 'Reconnecting…';
        });
        return socket;
    }
    $('retro-open-create').disabled = !catalog.some(game => game.available);
    function renderSettings(selectId = 'retro-game-select', containerId = 'retro-match-settings', values = {}) {
        const selected = catalog.find(game => game.id === $(selectId).value);
        const container = $(containerId);
        container.replaceChildren();
        for (const field of selected?.settings || []) {
            const label = document.createElement('label'), select = document.createElement('select');
            select.id = containerId + '-' + field.key; select.dataset.setting = field.key;
            select.className = 'modal-input'; label.htmlFor = select.id; label.textContent = field.label;
            for (const choice of field.choices) {
                const option = document.createElement('option');
                option.value = choice.value; option.textContent = choice.label;
                option.selected = choice.value === (values[field.key] ?? field.default); select.append(option);
            }
            container.append(label, select);
        }
    }
    $('retro-game-select').addEventListener('change', () => renderSettings());
    $('retro-next-game').addEventListener('change', () => renderSettings('retro-next-game', 'retro-next-settings'));
    $('retro-change-game').addEventListener('submit', event => {
        event.preventDefault();
        const selected = catalog.find(entry => entry.id === $('retro-next-game').value);
        if (!selected?.available || returning) return;
        const settings = Object.fromEntries(Array.from($('retro-next-settings').querySelectorAll('select'), field => [field.dataset.setting, Number(field.value)]));
        socket.emit('change_game', {gameId: selected.id, compatibility: selected, settings});
    });
    renderSettings();
    $('retro-open-create').addEventListener('click', () => dialog.showModal());
    $('retro-cancel-create').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    $('retro-create-form').addEventListener('submit', event => {
        event.preventDefault();
        const selected = catalog.find(game => game.id === $('retro-game-select').value);
        if (!selected?.available) return;
        createButton.disabled = true;
        const settings = Object.fromEntries(Array.from($('retro-match-settings').querySelectorAll('select'), field => [field.dataset.setting, Number(field.value)]));
        connect().emit('create', {name: $('retro-room-name').value.trim(), gameId: selected.id, compatibility: selected, settings});
    });
    $('retro-choose-player').addEventListener('click', () => socket.emit('role', {role: 'player'}));
    $('retro-choose-spectator').addEventListener('click', () => socket.emit('role', {role: 'spectator'}));
    startButton.addEventListener('click', () => socket.emit('start_game'));
    $('retro-close-game').addEventListener('click', () => {
        if (memberId === hostId && !returning) socket.emit('return_lobby');
    });
    $('retro-leave-room').addEventListener('click', () => { socket.emit('leave'); clearRoom(); });
    $('retro-back-rooms').addEventListener('click', () => {
        lobby.hidden = true; browser.hidden = false; $('retro-back-rooms').hidden = true; socket.emit('list');
    });
    $('retro-return').addEventListener('click', async () => {
        const button = $('retro-return');
        if (button.disabled) return;
        button.disabled = true;
        $('retro-runtime-status').textContent = 'Leaving the game…';
        // An intentional leave revokes this membership. Do not try to resume
        // its old seat when the same browser later joins as a spectator.
        if (code) { try { sessionStorage.removeItem('retro-resume:' + code); localStorage.removeItem('retro-party-resume:' + code); } catch {} }
        resumeToken = undefined;
        // Navigation closes the transport. Let the server distinguish an intentional
        // departure from a recoverable connection loss before replacing this page.
        await disposeRuntime().catch(error => { $('retro-runtime-status').textContent = error.message; });
        socket.timeout(2000).emit('leave', () => { location.href = location.pathname; });
    });
    $('retro-copy-invite').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText($('retro-invite').value); lobbyNotice.textContent = 'Invite copied.'; }
        catch { $('retro-invite').select(); lobbyNotice.textContent = 'Copy the selected invite link.'; }
    });
    $('retro-download-report').addEventListener('click', () => {
        if (!interruptionReport) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(interruptionReport, null, 2) + '\n'], {type: 'application/json'}));
        const link = document.createElement('a');
        link.href = url; link.download = 'retro-' + interruptionReport.reason + '-' + interruptionReport.game.id + '-' + interruptionReport.frame + '.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    connect();
})();
