/* static/js/room_player.js */

document.addEventListener('DOMContentLoaded', () => {
    console.log("🚀 Room Player Loaded (Rubber-Band Viewer Version)");

    // --- 1. CONFIG & SETUP ---
    const appContainer = document.getElementById('room-app');
    if (!appContainer) {
        console.error("CRITICAL: Room App container not found!");
        return;
    }

    const ROOM_ID = appContainer.dataset.roomId;
    let INITIAL_MEDIA_URL = appContainer.dataset.initialMediaUrl;
    let CURRENT_KEY = appContainer.dataset.currentKey;

    // Identity Variables
    let isHost = appContainer.dataset.isHost === 'true';
    let HOST_USERNAME = appContainer.dataset.hostUsername;

    let socket = null;
    let hls = null;

    // Sync State Variables
    let syncInterval = null;
    let localSyncStartTime = 0;
    let mediaOffset = 0;
    let isBuffering = false;
    let ignoreSyncWindow = false;
    let isSystemAction = false;
    let roomIsPlaying = true; // NEW: Tracks the global state of the room

    // --- 2. ELEMENT SELECTION ---
    const searchBtn = document.getElementById('btn-open-search');
        if (searchBtn) searchBtn.style.display = isHost ? 'inline-block' : 'none';
    const video = document.getElementById('video-player');
    const mediaTitleElem = document.getElementById('media-title');
    const btnStreamSettings = document.getElementById('btn-stream-settings');
    const chatBox = document.getElementById('chat-box');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('btn-send-chat');

    const searchModal = document.getElementById('searchModal');
    const openSearchBtn = document.getElementById('btn-open-search');
    const closeSearchBtn = document.getElementById('btn-close-search');
    const searchPlexBtn = document.getElementById('btn-search-plex');
    const searchInput = document.getElementById('plex-search-input');
    const resultsContainer = document.getElementById('search-results');

    const optionsModal = document.getElementById('optionsModal');
    const closeOptionsBtn = document.getElementById('btn-close-options');
    const confirmPlayBtn = document.getElementById('btn-confirm-play');
    const audioSelect = document.getElementById('audio-select');
    const subtitleSelect = document.getElementById('subtitle-select');
    const qualitySelect = document.getElementById('quality-select');
    const optionsTitle = document.getElementById('options-media-title');

    let currentSelectedMedia = null;

    // --- NATIVE BUFFERING DETECTION (Host Only) ---
    video.addEventListener('waiting', () => {
        // Viewers buffering no longer pause the room. Only the Host dictates flow.
        if (isHost && !isBuffering && socket && !ignoreSyncWindow) {
            isBuffering = true;
            socket.emit('user_buffering', { room_id: ROOM_ID });
        }
    });

    video.addEventListener('canplay', () => {
        if (isHost && isBuffering && socket) {
            socket.emit('buffer_resolved', {
                room_id: ROOM_ID,
                current_time: video.currentTime
            });
        }
    });

    // --- MANUAL SYNC LISTENERS ---
    video.addEventListener('pause', () => {
        if (isSystemAction) return;

        if (isHost) {
            // Host pauses the whole room
            if (socket) socket.emit('user_pause', { room_id: ROOM_ID });
        }
        // If viewer pauses, they just pause locally. No emit needed.
    });

    video.addEventListener('play', () => {
        if (isSystemAction) return;

        if (isHost) {
            // Host resumes the whole room
            if (socket) socket.emit('user_play', { room_id: ROOM_ID, current_time: video.currentTime });
        } else {
            // VIEWER RESUMES PLAYBACK: Rubber-band them to the host!
            if (!roomIsPlaying) {
                // If the host has the room paused, force the viewer to stay paused
                isSystemAction = true;
                video.pause();
                setTimeout(() => { isSystemAction = false; }, 100);
            } else {
                // Room is live! Snap the viewer to the exact host time.
                const expectedTime = ((Date.now() / 1000) - localSyncStartTime) + mediaOffset;
                if (Math.abs(video.currentTime - expectedTime) > 1.0) {
                    isSystemAction = true;
                    video.currentTime = expectedTime;
                    setTimeout(() => { isSystemAction = false; }, 100);
                }
            }
        }
    });

    // --- VIEWER SEEK DETECTION ---
    video.addEventListener('seeked', () => {
        if (isSystemAction || isHost) return;

        // If a viewer clicks around the timeline, force them back to reality
        if (roomIsPlaying) {
            const expectedTime = ((Date.now() / 1000) - localSyncStartTime) + mediaOffset;
            isSystemAction = true;
            video.currentTime = expectedTime;
            setTimeout(() => { isSystemAction = false; }, 100);
        } else {
            isSystemAction = true;
            video.currentTime = mediaOffset; // Snap to where the host paused it
            setTimeout(() => { isSystemAction = false; }, 100);
        }
    });

    // ==========================================
    // PHASE 1: ACTIVATE BUTTONS
    // ==========================================

    if (qualitySelect) {
        qualitySelect.addEventListener('change', (e) => {
            if (hls) hls.currentLevel = parseInt(e.target.value);
        });
    }

    if(openSearchBtn) openSearchBtn.addEventListener('click', () => { if (searchModal) { searchModal.classList.add('active'); if(searchInput) searchInput.focus(); } });
    if(closeSearchBtn) closeSearchBtn.addEventListener('click', () => { if (searchModal) searchModal.classList.remove('active'); });
    if(closeOptionsBtn) closeOptionsBtn.addEventListener('click', () => { if (optionsModal) optionsModal.classList.remove('active'); });

    if (btnStreamSettings) {
        btnStreamSettings.addEventListener('click', () => {
            if (!CURRENT_KEY) return alert("No media is currently playing.");
            openPlaybackOptions({ key: `/library/metadata/${CURRENT_KEY}`, title: mediaTitleElem ? mediaTitleElem.innerText : "Current Media", isResume: true });
        });
    }

    if(confirmPlayBtn) {
        confirmPlayBtn.addEventListener('click', () => {
            if (currentSelectedMedia) selectMedia(currentSelectedMedia, audioSelect.value, subtitleSelect.value);
        });
    }

    let navigationStack = [];
    if (searchPlexBtn) {
        searchPlexBtn.addEventListener('click', async () => {
            const query = searchInput.value.trim();
            if(!query) return;
            navigationStack = [];
            loadResults(`/api/plex/search?q=${encodeURIComponent(query)}`);
        });
    }
    if (searchInput) searchInput.addEventListener('keypress', (e) => { if(e.key === 'Enter') searchPlexBtn.click(); });


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
                    if(text) { socket.emit('chat_message', { room_id: ROOM_ID, text: text }); chatInput.value = ''; }
                });
            }
            if (chatInput) chatInput.addEventListener('keypress', (e) => { if(e.key === 'Enter') sendBtn.click(); });

            socket.on('chat_message', (data) => { addMessage(data.user, data.text); });

            socket.on('media_updated', (data) => {
                if (String(data.room_id) !== String(ROOM_ID)) return;
                roomIsPlaying = true;

                if(mediaTitleElem) mediaTitleElem.innerText = data.title;
                CURRENT_KEY = data.rating_key;
                if(appContainer) appContainer.dataset.currentKey = data.rating_key;

                localSyncStartTime = Date.now() / 1000;
                mediaOffset = data.start_time;

                if (hls) { hls.stopLoad(); hls.detachMedia(); hls.destroy(); hls = null; }
                loadVideo(data.url, data.start_time);
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

                    // Add a pointer cursor if you are the host so you know it's clickable
                    if (isHost && user !== HOST_USERNAME) uDiv.style.cursor = 'pointer';

                    let hostBadge = user === HOST_USERNAME ? '(Host) ' : '';

                    uDiv.innerHTML = `
                        <div style="background: #e50914; color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.85em;">
                            ${user.charAt(0).toUpperCase()}
                        </div>
                        <span style="font-weight: 500;">${hostBadge}${user}</span>
                    `;

                    // NEW: Right-Click "Transfer Host" Menu
                    uDiv.addEventListener('contextmenu', (e) => {
                        e.preventDefault(); // Prevents the default browser right-click menu
                        if (isHost && user !== HOST_USERNAME) {
                            if (confirm(`Crown ${user} as the new room host?`)) {
                                socket.emit('transfer_host', { room_id: ROOM_ID, new_host: user });
                            }
                        }
                    });

                    usersListElem.appendChild(uDiv);
                });
            });
            // --- NEW: DYNAMIC HOST SWAPPING ---
            socket.on('host_changed', (data) => {
                HOST_USERNAME = data.new_host;
                const currentUsername = appContainer.dataset.username;
                isHost = (HOST_USERNAME === currentUsername);

                // Have the system formally announce the transition in chat
                addMessage("System", `<span style="color:#e5a00d;"> ${HOST_USERNAME} Is now the host</span>`);

                // Re-evaluate the UI Controls
                const currentSearchBtn = document.getElementById('btn-open-search');
                if (isHost) {
                    // Turn on God-Mode
                    video.setAttribute('controls', 'controls');
                    video.style.pointerEvents = 'auto';
                    if (currentSearchBtn) currentSearchBtn.style.display = 'inline-block';
                } else {
                    // Turn on Viewer-Mode
                    video.removeAttribute('controls');
                    video.style.pointerEvents = 'none';
                    if (currentSearchBtn) currentSearchBtn.style.display = 'none';
                }
            });
            socket.on('force_pause', (data) => {
                roomIsPlaying = false;
                isSystemAction = true;
                video.pause();
                setTimeout(() => { isSystemAction = false; }, 100);
            });

            socket.on('force_play', (data) => {
                roomIsPlaying = true;
                localSyncStartTime = Date.now() / 1000;
                mediaOffset = data.offset;
                ignoreSyncWindow = true;
                setTimeout(() => { ignoreSyncWindow = false; }, 3000);

                if (Math.abs(video.currentTime - data.offset) > 1.0) {
                    video.currentTime = data.offset;
                }

                isBuffering = false;
                isSystemAction = true;
                video.play().catch(e => console.log("Autoplay blocked"));
                setTimeout(() => { isSystemAction = false; }, 100);
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
                // VIEWER SYNC LOGIC: Just tweak playback speeds to keep them chained to the host
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
                // HOST SYNC LOGIC: Maintain the ability to buffer the entire room if the host lags
                if (drift > 3.0) {
                    isBuffering = true;
                    video.pause();
                    if (socket) socket.emit('user_buffering', { room_id: ROOM_ID });
                    if (video.readyState >= 3) {
                        setTimeout(() => {
                            if (socket) socket.emit('buffer_resolved', { room_id: ROOM_ID, current_time: video.currentTime });
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

    // --- NEW: HOST CHAT BADGE ---
    function addMessage(user, text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-msg';

        // If the user sending the message is the host, style it differently
        if (user === HOST_USERNAME) {
            msgDiv.innerHTML = `<strong style="color: #e5a00d;">${user} (Host)</strong> <span style="color:#ececec;">${text}</span>`;
        } else {
            msgDiv.innerHTML = `<strong>${user}</strong> <span style="color:#ccc;">${text}</span>`;
        }

        chatBox.appendChild(msgDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    async function loadResults(url, isDrillDown = false) {
        resultsContainer.innerHTML = '<p style="color:#ccc; text-align:center; margin-top:50px;">Loading...</p>';
        try {
            const response = await fetch(url);
            const items = await response.json();
            resultsContainer.innerHTML = '';

            if(items.length === 0) {
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
                    if (previous) loadResults(previous.url, navigationStack.length > 0);
                    else if (searchInput.value) searchPlexBtn.click();
                });
                resultsContainer.appendChild(backBtn);
            }

            items.forEach(item => {
                const card = document.createElement('div');
                card.className = `movie-card ${cardClass}`;
                let imageUrl = item.thumb ? `/api/plex/image?path=${encodeURIComponent(item.thumb)}` : 'https://via.placeholder.com/300x450';
                let subTitle = item.year || '';
                if(item.type === 'Episode' || item.type === 'Season') subTitle = item.type;

                card.innerHTML = `
                    <div class="movie-card-image"><img src="${imageUrl}" loading="lazy"></div>
                    <div class="movie-info"><div class="movie-title">${item.title}</div><div class="movie-meta">${subTitle}</div></div>
                `;
                card.addEventListener('click', () => handleItemClick(item));
                resultsContainer.appendChild(card);
            });
        } catch(err) {
            resultsContainer.innerHTML = '<p style="color:red; text-align:center;">Error loading data.</p>';
        }
    }

    function handleItemClick(item) {
        if (item.type === 'Show' || item.type === 'Season') {
            navigationStack.push({ url: `/api/plex/children?key=${item.key}` });
            loadResults(`/api/plex/children?key=${item.key}`, true);
        } else if (item.type === 'Movie' || item.type === 'Episode') {
            openPlaybackOptions(item);
        }
    }

    async function openPlaybackOptions(item) {
        currentSelectedMedia = item;
        optionsTitle.innerText = item.title;

        audioSelect.innerHTML = '<option>Loading...</option>';
        subtitleSelect.innerHTML = '<option>Loading...</option>';
        optionsModal.classList.add('active');

        try {
            const rawKey = String(item.key);
            const keyForApi = rawKey.split('/').pop();
            const response = await fetch(`/api/plex/metadata/${keyForApi}`);
            const data = await response.json();

            if (data.audio && data.audio.length > 0) {
                audioSelect.innerHTML = '';
                data.audio.forEach(stream => {
                    const opt = document.createElement('option');
                    opt.value = stream.id;
                    opt.text = `${stream.language || 'Unknown'} (${stream.title})`;
                    if (stream.selected) opt.selected = true;
                    audioSelect.appendChild(opt);
                });
            } else {
                audioSelect.innerHTML = '<option value="">Default Audio</option>';
            }

            if (data.subtitles && data.subtitles.length > 0) {
                subtitleSelect.innerHTML = '';
                data.subtitles.forEach(stream => {
                    const opt = document.createElement('option');
                    opt.value = stream.id;
                    opt.text = `${stream.language || 'None'} (${stream.title})`;
                    if (stream.selected) opt.selected = true;
                    subtitleSelect.appendChild(opt);
                });
            } else {
                subtitleSelect.innerHTML = '<option value="">None</option>';
            }

        } catch (err) {
            audioSelect.innerHTML = '<option value="">Error loading</option>';
            subtitleSelect.innerHTML = '<option value="">Error loading</option>';
        }
    }

    async function selectMedia(media, audioId = null, subId = null) {
        const rawKey = String(media.key).split('/').pop();
        const payload = { rating_key: rawKey };

        if (audioId && audioId !== 'Loading...') payload.audio_stream_id = audioId;
        if (subId && subId !== 'Loading...') payload.subtitle_stream_id = subId;

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

            if(data.success) {
                if(searchModal) searchModal.classList.remove('active');
                if(optionsModal) optionsModal.classList.remove('active');
            } else {
                alert("Server Error: " + data.error);
            }
        } catch(err) {
            alert("Error setting media");
        }
    }

    function loadVideo(url, startTime = 0) {
        if (!url) return;

        ignoreSyncWindow = true;
        setTimeout(() => { ignoreSyncWindow = false; }, 4000);

        if (Hls.isSupported()) {
            hls = new Hls({
                debug: false,
                enableWorker: true,
                lowLatencyMode: true,
                startPosition: startTime > 0 ? startTime : -1,

                abrEwmaDefaultEstimate: 1000000,
                abrBandWidthFactor: 0.7,
                abrBandWidthUpFactor: 0.5,
                capLevelToPlayerSize: true,
                startLevel: -1
            });
            hls.loadSource(url);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
                if (qualitySelect) {
                    qualitySelect.innerHTML = '<option value="-1">Auto (Adaptive)</option>';
                    data.levels.forEach((level, index) => {
                        const opt = document.createElement('option');
                        opt.value = index;
                        opt.text = `${level.height}p`;
                        qualitySelect.appendChild(opt);
                    });
                    qualitySelect.value = "-1";
                }

                if (startTime > 0) video.currentTime = startTime;
                video.play().catch(e => console.log("Autoplay blocked"));
            });

            hls.on(Hls.Events.ERROR, function (event, data) {
                 if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            hls.recoverMediaError();
                            break;
                        default:
                            hls.destroy();
                            break;
                    }
                }
            });
        }
        else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
            video.addEventListener('loadedmetadata', function() {
                if (startTime > 0) video.currentTime = startTime;
                video.play();
            }, { once: true });
        }
    }

    if(INITIAL_MEDIA_URL) {
        loadVideo(INITIAL_MEDIA_URL);
    }
});