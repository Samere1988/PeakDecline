/* static/js/room_player.js */

document.addEventListener('DOMContentLoaded', () => {
    console.log("🚀 Room Player Loaded (Reconnect-Safe Edition - Plex/Game Mode Fixed)");

    // --- 1. CONFIG & SETUP ---
    const appContainer = document.getElementById('room-app');
    if (!appContainer) {
        console.error("CRITICAL: Room App container not found!");
        return;
    }

    const ROOM_ID = appContainer.dataset.roomId;
    let INITIAL_MEDIA_URL = appContainer.dataset.initialMediaUrl;
    let CURRENT_KEY = appContainer.dataset.currentKey;

    let isHost = appContainer.dataset.isHost === 'true';
    let HOST_USERNAME = appContainer.dataset.hostUsername;

    let socket = null;
    let hls = null;

    let syncInterval = null;
    let localSyncStartTime = 0;
    let mediaOffset = 0;
    let isBuffering = false;
    let ignoreSyncWindow = false;
    let isSystemAction = false;
    let roomIsPlaying = true;
    let currentMediaUrl = INITIAL_MEDIA_URL || '';

    // --- WEBRTC & EMULATOR VARIABLES ---
    let peerConnections = {};
    let localStream = null;

    const ICE_SERVERS = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            {
                urls: [
                    'turn:174.89.165.4:3478?transport=udp',
                    'turn:174.89.165.4:3478?transport=tcp'
                ],
                username: 'peakturn',
                credential: '100%Wagie!'
            }
        ],

        // Use "relay" while testing TURN.
        // Later, you can switch this to "all" so direct WebRTC is used when possible.
        iceTransportPolicy: 'relay'
    };

    // --- 2. ELEMENT SELECTION ---
    const openSearchBtn = document.getElementById('btn-open-search');
    const btnOpenGames = document.getElementById('btn-open-games');
    const btnStartBroadcast = document.getElementById('btn-start-broadcast');
    const btnStopGame = document.getElementById('btn-stop-game');

    const video = document.getElementById('video-player');
    const gameContainer = document.getElementById('game-container');
    const remoteVideo = document.getElementById('remote-video');
    const mediaTitleElem = document.getElementById('media-title');

    const chatBox = document.getElementById('chat-box');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('btn-send-chat');

    const searchModal = document.getElementById('searchModal');
    const closeSearchBtn = document.getElementById('btn-close-search');
    const searchPlexBtn = document.getElementById('btn-search-plex');
    const searchInput = document.getElementById('plex-search-input');
    const resultsContainer = document.getElementById('search-results');

    const gameModal = document.getElementById('gameModal');
    const closeGamesBtn = document.getElementById('btn-close-games');
    const gameResults = document.getElementById('game-results');

    let navigationStack = [];

    // --- UI STATE MANAGER ---
    function setUIState(state) {
        if (video) video.style.display = 'none';
        if (gameContainer) gameContainer.style.display = 'none';
        if (remoteVideo) remoteVideo.style.display = 'none';
        if (btnStopGame) btnStopGame.style.display = 'none';
        if (btnStartBroadcast) btnStartBroadcast.style.display = 'none';

        if (state === 'plex') {
            if (video) video.style.display = 'block';
        } else if (state === 'emulator-host') {
            if (gameContainer) gameContainer.style.display = 'block';
            if (isHost && btnStopGame) btnStopGame.style.display = 'inline-block';
            if (isHost && btnStartBroadcast) btnStartBroadcast.style.display = 'inline-block';
        } else if (state === 'emulator-viewer') {
            if (remoteVideo) remoteVideo.style.display = 'block';
        }
    }

    function applyHostPermissions() {
        if (isHost) {
            if (video) {
                video.setAttribute('controls', 'controls');
                video.style.pointerEvents = 'auto';
            }
            if (openSearchBtn) openSearchBtn.style.display = 'inline-block';
            if (btnOpenGames) btnOpenGames.style.display = 'inline-block';
        } else {
            if (video) {
                video.removeAttribute('controls');
                video.style.pointerEvents = 'none';
            }
            if (openSearchBtn) openSearchBtn.style.display = 'none';
            if (btnOpenGames) btnOpenGames.style.display = 'none';
            if (btnStartBroadcast) btnStartBroadcast.style.display = 'none';
        }
    }

    function setPlaybackClock(startEpoch, offset) {
        mediaOffset = Number(offset || 0);
        localSyncStartTime = Number(startEpoch || 0);

        const localNow = Date.now() / 1000;
        if (!localSyncStartTime || Math.abs(localNow - localSyncStartTime) > 300) {
            localSyncStartTime = localNow;
        }
    }

    function destroyHls() {
        if (hls) {
            try { hls.stopLoad(); } catch (e) {}
            try { hls.detachMedia(); } catch (e) {}
            try { hls.destroy(); } catch (e) {}
            hls = null;
        }
    }

    function safePauseVideo() {
        if (!video) return;

        isSystemAction = true;
        try {
            video.pause();
        } catch (e) {}

        setTimeout(() => {
            isSystemAction = false;
        }, 150);
    }

    function switchToPlexMode() {
        stopLocalBroadcast();

        if (remoteVideo) {
            try { remoteVideo.pause(); } catch (e) {}
            remoteVideo.srcObject = null;
            remoteVideo.removeAttribute('src');
        }

        setUIState('plex');

        if (video) {
            video.style.display = 'block';
        }
    }

    function resetVideoElement() {
        if (!video) return;

        try {
            video.pause();
            video.removeAttribute('src');
            video.load();
        } catch (e) {}
    }

    applyHostPermissions();

    // --- NATIVE BUFFERING DETECTION (Host Only) ---
    if (video) {
        video.addEventListener('waiting', () => {
            if (isHost && !isBuffering && socket && !ignoreSyncWindow) {
                isBuffering = true;
                socket.emit('user_buffering', {
                    room_id: ROOM_ID,
                    current_time: video.currentTime || mediaOffset || 0
                });
            }
        });

        video.addEventListener('canplay', () => {
            if (isHost && isBuffering && socket) {
                socket.emit('buffer_resolved', {
                    room_id: ROOM_ID,
                    current_time: video.currentTime || mediaOffset || 0
                });
            }
        });

        // --- MANUAL SYNC LISTENERS ---
        video.addEventListener('pause', () => {
            if (isSystemAction) return;

            if (isHost && socket) {
                socket.emit('user_pause', {
                    room_id: ROOM_ID,
                    current_time: video.currentTime || 0
                });
            }
        });

        video.addEventListener('play', () => {
            if (isSystemAction) return;

            if (isHost) {
                if (socket) {
                    socket.emit('user_play', {
                        room_id: ROOM_ID,
                        current_time: video.currentTime || 0
                    });
                }
            } else {
                if (!roomIsPlaying) {
                    safePauseVideo();
                } else {
                    const expectedTime = ((Date.now() / 1000) - localSyncStartTime) + mediaOffset;
                    if (Math.abs(video.currentTime - expectedTime) > 1.0) {
                        isSystemAction = true;
                        video.currentTime = expectedTime;
                        setTimeout(() => { isSystemAction = false; }, 100);
                    }
                }
            }
        });

        video.addEventListener('seeked', () => {
            if (isSystemAction || isHost) return;

            if (roomIsPlaying) {
                const expectedTime = ((Date.now() / 1000) - localSyncStartTime) + mediaOffset;
                isSystemAction = true;
                video.currentTime = expectedTime;
                setTimeout(() => { isSystemAction = false; }, 100);
            } else {
                isSystemAction = true;
                video.currentTime = mediaOffset;
                setTimeout(() => { isSystemAction = false; }, 100);
            }
        });
    }

    // ==========================================
    // PHASE 1: ACTIVATE BUTTONS
    // ==========================================

    if (openSearchBtn) {
        openSearchBtn.addEventListener('click', () => {
            if (searchModal) {
                searchModal.classList.add('active');
                if (searchInput) searchInput.focus();
            }
        });
    }

    if (closeSearchBtn) {
        closeSearchBtn.addEventListener('click', () => {
            if (searchModal) searchModal.classList.remove('active');
        });
    }

    if (btnOpenGames) {
        btnOpenGames.addEventListener('click', () => {
            if (gameModal) gameModal.classList.add('active');
        });
    }

    if (closeGamesBtn) {
        closeGamesBtn.addEventListener('click', () => {
            if (gameModal) gameModal.classList.remove('active');
        });
    }

    if (searchPlexBtn) {
        searchPlexBtn.addEventListener('click', async () => {
            const query = searchInput.value.trim();
            if (!query) return;
            navigationStack = [];
            loadResults(`/api/plex/search?q=${encodeURIComponent(query)}`);
        });
    }

    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') searchPlexBtn.click();
        });
    }

    // ==========================================
    // PHASE 2: SOCKET & MEDIA LOGIC
    // ==========================================

    try {
        if (typeof io !== 'undefined') {
            socket = io();

            socket.emit('join_watch_room', { room_id: ROOM_ID });

            if (sendBtn) {
                sendBtn.addEventListener('click', () => {
                    const text = chatInput.value.trim();
                    if (text) {
                        socket.emit('chat_message', { room_id: ROOM_ID, text: text });
                        chatInput.value = '';
                    }
                });
            }

            if (chatInput) {
                chatInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') sendBtn.click();
                });
            }

            socket.on('chat_message', (data) => {
                addMessage(data.user, data.text);
            });

            socket.on('room_missing', (data) => {
                alert(data.message || 'This room no longer exists.');
                window.location.href = '/plex-watch-together';
            });

            socket.on('room_state', (data) => {
                if (String(data.room_id) !== String(ROOM_ID)) return;
                if (!data.url) return;

                switchToPlexMode();

                currentMediaUrl = data.url;
                roomIsPlaying = data.is_playing !== false;
                isBuffering = false;

                if (mediaTitleElem) {
                    mediaTitleElem.innerText = data.title || 'Now Playing';
                }

                CURRENT_KEY = data.rating_key || '';
                if (appContainer) appContainer.dataset.currentKey = CURRENT_KEY;

                const currentTime = Number(data.current_time || data.offset || 0);

                // The server already calculated current_time for reconnects,
                // so anchor the clock to the browser's current time.
                setPlaybackClock(Date.now() / 1000, currentTime);

                loadVideo(data.url, currentTime, roomIsPlaying);
                startSyncLoop();
            });

            socket.on('media_updated', (data) => {
                if (String(data.room_id) !== String(ROOM_ID)) return;
                if (!data.url) return;

                switchToPlexMode();

                currentMediaUrl = data.url;
                roomIsPlaying = true;
                isBuffering = false;

                if (mediaTitleElem) {
                    mediaTitleElem.innerText = data.title || 'Now Playing';
                }

                CURRENT_KEY = data.rating_key || '';
                if (appContainer) appContainer.dataset.currentKey = CURRENT_KEY;

                const startTime = Number(data.start_time || data.offset || 0);

                setPlaybackClock(data.server_epoch || (Date.now() / 1000), startTime);

                loadVideo(data.url, startTime, true);
                startSyncLoop();
            });

            const usersListElem = document.getElementById('users-list');
            socket.on('room_users_update', (users) => {
                if (!usersListElem) return;
                usersListElem.innerHTML = '';

                users.forEach(user => {
                    const uDiv = document.createElement('div');
                    uDiv.style.padding = '12px 15px';
                    uDiv.style.borderBottom = '1px solid #222630';
                    uDiv.style.color = '#ececec';
                    uDiv.style.display = 'flex';
                    uDiv.style.alignItems = 'center';
                    uDiv.style.gap = '10px';

                    if (isHost && user !== HOST_USERNAME) uDiv.style.cursor = 'pointer';

                    const hostBadge = user === HOST_USERNAME ? '(Host) ' : '';

                    uDiv.innerHTML = `
                        <div style="background: #e50914; color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.85em;">
                            ${user.charAt(0).toUpperCase()}
                        </div>
                        <span style="font-weight: 500;">${hostBadge}${user}</span>
                    `;

                    uDiv.addEventListener('contextmenu', (e) => {
                        e.preventDefault();

                        if (isHost && user !== HOST_USERNAME) {
                            if (confirm(`Crown ${user} as the new room host?`)) {
                                socket.emit('transfer_host', {
                                    room_id: ROOM_ID,
                                    new_host: user
                                });
                            }
                        }
                    });

                    usersListElem.appendChild(uDiv);
                });
            });

            socket.on('host_changed', (data) => {
                HOST_USERNAME = data.new_host;
                const currentUsername = appContainer.dataset.username;
                isHost = (HOST_USERNAME === currentUsername);

                addMessage("System", `<span style="color:#e5a00d;">${HOST_USERNAME} is now the host</span>`);
                applyHostPermissions();

                if (!isHost) stopLocalBroadcast();
            });

            socket.on('force_pause', (data) => {
                const offset = Number(data.offset ?? video.currentTime ?? mediaOffset ?? 0);

                roomIsPlaying = false;
                mediaOffset = offset;
                localSyncStartTime = Date.now() / 1000;
                isBuffering = false;

                safePauseVideo();

                if (video && Number.isFinite(offset) && Math.abs(video.currentTime - offset) > 0.75) {
                    isSystemAction = true;
                    video.currentTime = offset;
                    setTimeout(() => { isSystemAction = false; }, 100);
                }
            });

            socket.on('force_play', (data) => {
                roomIsPlaying = true;
                setPlaybackClock(data.server_epoch || data.start_time, data.offset || 0);

                ignoreSyncWindow = true;
                setTimeout(() => { ignoreSyncWindow = false; }, 3000);

                if (video && Math.abs(video.currentTime - mediaOffset) > 1.0) {
                    video.currentTime = mediaOffset;
                }

                isBuffering = false;
                isSystemAction = true;

                if (video) {
                    video.play().catch(e => console.log("Autoplay blocked", e));
                }

                setTimeout(() => { isSystemAction = false; }, 100);
            });

            // WEBRTC SIGNALING LOGIC
            socket.on('host_started_game', (data) => {
                if (String(data.room_id) !== String(ROOM_ID)) return;

                if (!isHost) {
                    destroyHls();
                    safePauseVideo();
                    setUIState('emulator-viewer');

                    if (mediaTitleElem) {
                        mediaTitleElem.innerText = `🎮 Playing: ${data.game_name}`;
                    }

                    socket.emit('viewer_joined', ROOM_ID);
                }
            });

            socket.on('game_stopped', (data) => {
                if (String(data.room_id) !== String(ROOM_ID)) return;

                stopLocalBroadcast();

                if (remoteVideo) {
                    try { remoteVideo.pause(); } catch (e) {}
                    remoteVideo.srcObject = null;
                    remoteVideo.removeAttribute('src');
                }

                setUIState('plex');

                if (mediaTitleElem) {
                    mediaTitleElem.innerText = currentMediaUrl
                        ? "Game Stopped. Load media again."
                        : "Game Stopped. Select Media.";
                }
            });

            socket.on('viewer_joined', async (viewerId) => {
                if (!isHost || !localStream) return;

                console.log(`[WebRTC] Setting up connection for new viewer: ${viewerId}`);

                const pc = createPeerConnection(viewerId);
                localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                socket.emit('webrtc_offer', {
                    target: viewerId,
                    caller: socket.id,
                    sdp: pc.localDescription,
                    room_id: ROOM_ID
                });
            });

            socket.on('webrtc_offer', async (data) => {
                if (isHost) return;

                console.log("[WebRTC] Received stream offer from host.");

                const pc = createPeerConnection(data.caller);
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                socket.emit('webrtc_answer', {
                    target: data.caller,
                    caller: socket.id,
                    sdp: pc.localDescription,
                    room_id: ROOM_ID
                });
            });

            socket.on('webrtc_answer', async (data) => {
                if (!isHost) return;

                const pc = peerConnections[data.caller];
                if (pc) {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                }
            });

            socket.on('webrtc_ice_candidate', async (data) => {
                const pc = peerConnections[data.caller];

                if (pc) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                    } catch (e) {}
                }
            });
        }
    } catch (e) {
        console.error("❌ Error initializing socket:", e);
    }

    // ==========================================
    // PHASE 3: HELPER FUNCTIONS
    // ==========================================

    function startSyncLoop() {
        if (syncInterval) clearInterval(syncInterval);

        syncInterval = setInterval(() => {
            if (!video || video.paused || isBuffering || ignoreSyncWindow) return;

            const expectedTime = ((Date.now() / 1000) - localSyncStartTime) + mediaOffset;
            const actualTime = video.currentTime;
            const drift = expectedTime - actualTime;

            if (!isHost) {
                if (Math.abs(drift) > 3.0) {
                    isSystemAction = true;
                    video.currentTime = expectedTime;
                    setTimeout(() => { isSystemAction = false; }, 100);
                } else if (drift > 0.5) {
                    if (video.playbackRate !== 1.15) video.playbackRate = 1.15;
                } else if (drift < -0.5) {
                    if (video.playbackRate !== 0.9) video.playbackRate = 0.9;
                } else {
                    if (video.playbackRate !== 1.0) video.playbackRate = 1.0;
                }
            } else {
                if (drift > 3.0) {
                    isBuffering = true;
                    safePauseVideo();

                    if (socket) {
                        socket.emit('user_buffering', {
                            room_id: ROOM_ID,
                            current_time: video.currentTime || mediaOffset || 0
                        });
                    }

                    if (video.readyState >= 3) {
                        setTimeout(() => {
                            if (socket) {
                                socket.emit('buffer_resolved', {
                                    room_id: ROOM_ID,
                                    current_time: video.currentTime || mediaOffset || 0
                                });
                            }
                        }, 500);
                    }
                } else if (drift > 0.5) {
                    if (video.playbackRate !== 1.15) video.playbackRate = 1.15;
                } else if (drift < -0.5) {
                    if (video.playbackRate !== 0.9) video.playbackRate = 0.9;
                } else {
                    if (video.playbackRate !== 1.0) video.playbackRate = 1.0;
                }
            }
        }, 2000);
    }

    function addMessage(user, text) {
        if (!chatBox) return;

        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-msg';

        if (user === HOST_USERNAME) {
            msgDiv.innerHTML = `<strong style="color: #e5a00d;">${user} (Host)</strong> <span style="color:#ececec;">${text}</span>`;
        } else {
            msgDiv.innerHTML = `<strong>${user}</strong> <span style="color:#ccc;">${text}</span>`;
        }

        chatBox.appendChild(msgDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    async function loadResults(url, isDrillDown = false) {
        if (!resultsContainer) return;

        resultsContainer.innerHTML = '<p style="color:#ccc; text-align:center; margin-top:50px;">Loading...</p>';

        try {
            const response = await fetch(url);
            const items = await response.json();

            resultsContainer.innerHTML = '';

            if (items.length === 0) {
                resultsContainer.innerHTML = '<p style="color:#ccc; text-align:center;">No results found.</p>';
                return;
            }

            const firstItem = items[0];
            const isEpisodeMode = firstItem && firstItem.type === 'Episode';
            const cardClass = isEpisodeMode ? 'episode-style' : 'poster-style';

            if (isDrillDown && navigationStack.length > 0) {
                const backBtn = document.createElement('div');
                backBtn.className = `movie-card back-card ${cardClass}`;
                backBtn.innerHTML = `<div class="back-icon">⬅</div><div class="back-text">BACK</div>`;

                backBtn.addEventListener('click', () => {
                    navigationStack.pop();

                    const previous = navigationStack[navigationStack.length - 1];
                    if (previous) {
                        loadResults(previous.url, navigationStack.length > 0);
                    } else if (searchInput.value) {
                        searchPlexBtn.click();
                    }
                });

                resultsContainer.appendChild(backBtn);
            }

            items.forEach(item => {
                const card = document.createElement('div');
                card.className = `movie-card ${cardClass}`;

                const imageUrl = item.thumb
                    ? `/api/plex/image?path=${encodeURIComponent(item.thumb)}`
                    : 'https://via.placeholder.com/300x450';

                let subTitle = item.year || '';
                if (item.type === 'Episode' || item.type === 'Season') {
                    subTitle = item.type;
                }

                card.innerHTML = `
                    <div class="movie-card-image"><img src="${imageUrl}" loading="lazy"></div>
                    <div class="movie-info">
                        <div class="movie-title">${item.title}</div>
                        <div class="movie-meta">${subTitle}</div>
                    </div>
                `;

                card.addEventListener('click', () => handleItemClick(item));
                resultsContainer.appendChild(card);
            });
        } catch (err) {
            console.error("Plex search/load error:", err);
            resultsContainer.innerHTML = '<p style="color:red; text-align:center;">Error loading data.</p>';
        }
    }

    function handleItemClick(item) {
        if (item.type === 'Show' || item.type === 'Season') {
            navigationStack.push({ url: `/api/plex/children?key=${item.key}` });
            loadResults(`/api/plex/children?key=${item.key}`, true);
        } else if (item.type === 'Movie' || item.type === 'Episode') {
            selectMedia(item);
        }
    }

    async function selectMedia(media) {
        if (!isHost) return;

        const rawKey = String(media.key).split('/').pop();
        const payload = { rating_key: rawKey };

        if (media.isResume || rawKey === String(CURRENT_KEY)) {
            if (video && !video.paused && video.currentTime > 0) {
                payload.view_offset = video.currentTime;
            }
        }

        try {
            const response = await fetch(`/api/room/${ROOM_ID}/set_media`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (data.success) {
                if (searchModal) searchModal.classList.remove('active');
            } else {
                alert("Server Error: " + data.error);
            }
        } catch (err) {
            console.error("Error setting media:", err);
            alert("Error setting media");
        }
    }

    function loadVideo(url, startTime = 0, shouldPlay = true) {
        if (!url || !video) return;

        currentMediaUrl = url;
        setUIState('plex');

        ignoreSyncWindow = true;
        setTimeout(() => { ignoreSyncWindow = false; }, 4000);

        const targetStart = Number(startTime || 0);

        destroyHls();
        resetVideoElement();

        if (Hls.isSupported()) {
            hls = new Hls({
                debug: false,
                enableWorker: true,
                lowLatencyMode: true,
                startPosition: targetStart > 0 ? targetStart : -1,
                abrEwmaDefaultEstimate: 1000000,
                abrBandWidthFactor: 0.7,
                abrBandWidthUpFactor: 0.5,
                capLevelToPlayerSize: true,
                startLevel: -1
            });

            hls.loadSource(url);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, function () {
                if (targetStart > 0) {
                    try { video.currentTime = targetStart; } catch (e) {}
                }

                isSystemAction = true;

                if (shouldPlay) {
                    video.play().catch(err => {
                        console.warn("Plex autoplay blocked:", err);
                    });
                } else {
                    video.pause();
                }

                setTimeout(() => { isSystemAction = false; }, 200);
            });

            hls.on(Hls.Events.ERROR, function (event, data) {
                console.warn("HLS error:", data);

                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.warn("Fatal HLS network error. Restarting load.");
                            hls.startLoad();
                            break;

                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.warn("Fatal HLS media error. Recovering.");
                            hls.recoverMediaError();
                            break;

                        default:
                            console.error("Fatal unrecoverable HLS error.");
                            destroyHls();
                            break;
                    }
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;

            video.addEventListener('loadedmetadata', function () {
                if (targetStart > 0) {
                    try { video.currentTime = targetStart; } catch (e) {}
                }

                isSystemAction = true;

                if (shouldPlay) {
                    video.play().catch(err => {
                        console.warn("Native HLS autoplay blocked:", err);
                    });
                } else {
                    video.pause();
                }

                setTimeout(() => { isSystemAction = false; }, 200);
            }, { once: true });
        }
    }

    if (INITIAL_MEDIA_URL) {
        // Fallback only. The server's room_state event should replace this with the correct timestamp.
        loadVideo(INITIAL_MEDIA_URL, 0, true);
    }

    // ==========================================
    // PHASE 4: GAME BOOTING LOGIC (Host Only)
    // ==========================================

    window.fetchGames = async function(system) {
        if (!gameResults) return;

        gameResults.innerHTML = '<p style="color:#ccc; text-align:center;">Loading games...</p>';

        try {
            const res = await fetch(`/api/roms/${system}`);
            const games = await res.json();

            gameResults.innerHTML = '';

            if (games.length === 0) {
                gameResults.innerHTML = '<p style="color:#ccc; text-align:center;">No games found.</p>';
                return;
            }

            games.forEach(game => {
                const btn = document.createElement('button');
                btn.className = 'btn-choose-media';
                btn.style.cssText = "display: block; width: 100%; text-align: left; padding: 15px; margin-bottom: 5px; background: #222;";
                btn.innerText = game.name;
                btn.onclick = () => bootGame(game.core, game.path, game.name);
                gameResults.appendChild(btn);
            });
        } catch (err) {
            console.error("Error loading games:", err);
            gameResults.innerHTML = '<p style="color:red; text-align:center;">Error loading games.</p>';
        }
    };

    function bootGame(core, romPath, gameName) {
        if (!isHost) return;

        if (gameModal) gameModal.classList.remove('active');

        destroyHls();
        safePauseVideo();

        setUIState('emulator-host');

        if (mediaTitleElem) {
            mediaTitleElem.innerText = `🎮 Playing: ${gameName}`;
        }

        const wrapper = document.getElementById('game-container');
        if (!wrapper) return;

        wrapper.innerHTML = '<div id="game" style="width:100%; height:100%;"></div>';

        window.EJS_player = '#game';
        window.EJS_core = core;
        window.EJS_color = '#007BFF';
        window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
        window.EJS_gameUrl = '/static/' + romPath;

        const script = document.createElement('script');
        script.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
        document.body.appendChild(script);

        const checkCanvas = setInterval(() => {
            const canvas = document.querySelector('#game canvas');

            if (canvas) {
                clearInterval(checkCanvas);
                if (btnStartBroadcast) btnStartBroadcast.style.display = 'inline-block';
            }
        }, 1000);
    }

    if (btnStopGame) {
        btnStopGame.addEventListener('click', () => {
            if (!isHost) return;

            stopLocalBroadcast();

            const gameWrapper = document.getElementById('game-container');
            if (gameWrapper) gameWrapper.innerHTML = '';

            setUIState('plex');

            if (mediaTitleElem) {
                mediaTitleElem.innerText = currentMediaUrl
                    ? "Game Stopped. Load media again."
                    : "Game Stopped. Select Media.";
            }

            addMessage("System", "Host stopped the game.");

            if (socket) {
                socket.emit('host_stopped_game', { room_id: ROOM_ID });
            }
        });
    }

    if (btnStartBroadcast) {
        btnStartBroadcast.addEventListener('click', () => {
            if (!isHost) return;

            const canvas = document.querySelector('#game canvas');

            if (canvas) {
                const gameName = mediaTitleElem
                    ? mediaTitleElem.innerText.replace('🎮 Playing: ', '')
                    : 'A Game';

                startWebRTCBroadcast(canvas, gameName);
            }
        });
    }

    // ==========================================
    // PHASE 5: WEBRTC CORE LOGIC
    // ==========================================

    async function startWebRTCBroadcast(canvas, gameName) {
        if (!isHost) return;

        try {
            console.log("[WebRTC] Starting game broadcast...");

            const videoStream = canvas.captureStream(30);
            const tracks = [...videoStream.getVideoTracks()];

            console.log("[WebRTC] Captured video tracks:", tracks);

            // Audio is optional. If mic permission fails, still broadcast video.
            try {
                const audioStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false
                    },
                    video: false
                });

                tracks.push(...audioStream.getAudioTracks());
                console.log("[WebRTC] Mic audio captured.");
            } catch (audioErr) {
                console.warn("[WebRTC] Mic audio unavailable. Continuing video-only.", audioErr);
                addMessage("System", `<span style="color:#e5a00d;">Mic audio unavailable. Broadcasting video only.</span>`);
            }

            localStream = new MediaStream(tracks);

            if (localStream.getVideoTracks().length === 0) {
                throw new Error("No video track was captured from the emulator canvas.");
            }

            socket.emit('host_started_game', {
                room_id: ROOM_ID,
                game_name: gameName
            });

            addMessage("System", `<span style="color:#007BFF;">Game Broadcast Live! Viewers are tuning in.</span>`);

            if (btnStartBroadcast) btnStartBroadcast.style.display = 'none';
        } catch (err) {
            console.error("[WebRTC] Broadcast Error:", err);
            alert("Could not start game broadcast. Check the browser console for the WebRTC error.");
        }
    }

    function createPeerConnection(peerId) {
        console.log("[WebRTC] Creating peer connection for:", peerId);

        const pc = new RTCPeerConnection(ICE_SERVERS);
        peerConnections[peerId] = pc;

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                console.log("[WebRTC] Sending ICE candidate to:", peerId);

                socket.emit('webrtc_ice_candidate', {
                    target: peerId,
                    caller: socket.id,
                    candidate: e.candidate,
                    room_id: ROOM_ID
                });
            }
        };

        pc.ontrack = (e) => {
            console.log("[WebRTC] Remote track received:", e.track.kind, e.streams);

            if (!isHost && remoteVideo) {
                remoteVideo.srcObject = e.streams[0];
                remoteVideo.autoplay = true;
                remoteVideo.playsInline = true;
                remoteVideo.controls = true;

                // Mute first so browser autoplay is more likely to allow video playback.
                // User can unmute with controls later.
                remoteVideo.muted = true;

                setUIState('emulator-viewer');

                remoteVideo.play()
                    .then(() => {
                        console.log("[WebRTC] Remote video playing.");
                    })
                    .catch((err) => {
                        console.warn("[WebRTC] Remote video autoplay blocked:", err);
                        addMessage("System", `<span style="color:#e5a00d;">Click the video player to start the game stream.</span>`);
                    });
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log("[WebRTC] ICE state for", peerId, "=", pc.iceConnectionState);

            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                console.log("[WebRTC] Peer connected:", peerId);
            }

            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                console.warn("[WebRTC] Peer disconnected/failed:", peerId);
                pc.close();
                delete peerConnections[peerId];
            }
        };

        pc.onconnectionstatechange = () => {
            console.log("[WebRTC] Connection state for", peerId, "=", pc.connectionState);
        };

        return pc;
    }

    function stopLocalBroadcast() {
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }

        Object.values(peerConnections).forEach(pc => {
            try { pc.close(); } catch (e) {}
        });

        peerConnections = {};
    }
});