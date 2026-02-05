/* static/js/room_player.js */

document.addEventListener('DOMContentLoaded', () => {
    console.log("🚀 Room Player Loaded (Stable Version)");

    // --- 1. CONFIG & SETUP ---
    const appContainer = document.getElementById('room-app');
    if (!appContainer) {
        console.error("CRITICAL: Room App container not found!");
        return;
    }

    const ROOM_ID = appContainer.dataset.roomId;
    let INITIAL_MEDIA_URL = appContainer.dataset.initialMediaUrl;
    let CURRENT_KEY = appContainer.dataset.currentKey;

    // Global State
    let socket = null;
    let hls = null;

    // --- 2. ELEMENT SELECTION ---
    const video = document.getElementById('video-player');
    const mediaTitleElem = document.getElementById('media-title');
    const btnStreamSettings = document.getElementById('btn-stream-settings');

    const chatBox = document.getElementById('chat-box');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('btn-send-chat');

    // Modals
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
    const optionsTitle = document.getElementById('options-media-title');

    let currentSelectedMedia = null;

    // ==========================================
    // PHASE 1: ACTIVATE BUTTONS (Priority 1)
    // ==========================================

    // 1. SELECT MEDIA BUTTON
    if(openSearchBtn) {
        openSearchBtn.addEventListener('click', () => {
            console.log("🖱️ Select Media Clicked");
            if (searchModal) {
                searchModal.classList.add('active');
                if(searchInput) searchInput.focus();
            }
        });
    }

    if(closeSearchBtn) {
        closeSearchBtn.addEventListener('click', () => {
            if (searchModal) searchModal.classList.remove('active');
        });
    }

    // 2. STREAM SETTINGS
    if (btnStreamSettings) {
        btnStreamSettings.addEventListener('click', () => {
            if (!CURRENT_KEY) {
                alert("No media is currently playing.");
                return;
            }
            const currentItem = {
                key: `/library/metadata/${CURRENT_KEY}`,
                title: mediaTitleElem ? mediaTitleElem.innerText : "Current Media",
                isResume: true
            };
            openPlaybackOptions(currentItem);
        });
    }

    // 3. OPTIONS MODAL
    if(closeOptionsBtn) {
        closeOptionsBtn.addEventListener('click', () => {
            if (optionsModal) optionsModal.classList.remove('active');
        });
    }

    if(confirmPlayBtn) {
        confirmPlayBtn.addEventListener('click', () => {
            if (currentSelectedMedia) {
                const audioId = audioSelect.value;
                const subId = subtitleSelect.value;
                selectMedia(currentSelectedMedia, audioId, subId);
            }
        });
    }

    // 4. PLEX SEARCH
    let navigationStack = [];
    if (searchPlexBtn) {
        searchPlexBtn.addEventListener('click', async () => {
            const query = searchInput.value.trim();
            if(!query) return;
            navigationStack = [];
            loadResults(`/api/plex/search?q=${encodeURIComponent(query)}`);
        });
    }
    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if(e.key === 'Enter') searchPlexBtn.click();
        });
    }

    // ==========================================
    // PHASE 2: SOCKET & MEDIA LOGIC
    // ==========================================

    try {
        if (typeof io !== 'undefined') {
            socket = io();
            console.log("✅ Socket connected");

            // --- CHAT ---
            if (sendBtn) {
                sendBtn.addEventListener('click', () => {
                    const text = chatInput.value.trim();
                    if(text) {
                        socket.emit('chat_message', { room_id: ROOM_ID, text: text });
                        chatInput.value = '';
                    }
                });
            }
            if (chatInput) {
                chatInput.addEventListener('keypress', (e) => {
                    if(e.key === 'Enter') sendBtn.click();
                });
            }

            socket.on('chat_message', (data) => {
                addMessage(data.user, data.text);
            });

            // --- MEDIA UPDATE (Clean Switch) ---
            socket.on('media_updated', (data) => {
                if (String(data.room_id) !== String(ROOM_ID)) return;

                console.log("⚡ SOCKET: Media Update", data);

                if(mediaTitleElem) mediaTitleElem.innerText = data.title;
                CURRENT_KEY = data.rating_key;
                if(appContainer) appContainer.dataset.currentKey = data.rating_key;

                // Stop old stream
                if (hls) {
                    hls.stopLoad();
                    hls.detachMedia();
                    hls.destroy();
                    hls = null;
                }
                // Load new stream
                loadVideo(data.url, data.start_time);
            });

        } else {
            console.error("❌ Socket.IO library not loaded.");
        }
    } catch (e) {
        console.error("❌ Error initializing socket:", e);
    }

    // ==========================================
    // PHASE 3: HELPER FUNCTIONS
    // ==========================================

    function addMessage(user, text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-msg';
        msgDiv.innerHTML = `<strong>${user}</strong> ${text}`;
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

            // Back Button
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
                    <div class="movie-card-image">
                        <img src="${imageUrl}" loading="lazy">
                    </div>
                    <div class="movie-info">
                        <div class="movie-title">${item.title}</div>
                        <div class="movie-meta">${subTitle}</div>
                    </div>
                `;
                card.addEventListener('click', () => handleItemClick(item));
                resultsContainer.appendChild(card);
            });

        } catch(err) {
            console.error(err);
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
            if (!response.ok) throw new Error(`Server Error: ${response.status}`);
            const data = await response.json();

            // Populate Audio
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

            // Populate Subtitles
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
            console.error("Error fetching metadata:", err);
            audioSelect.innerHTML = '<option value="">Error loading options</option>';
            subtitleSelect.innerHTML = '<option value="">Error loading options</option>';
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
            console.error(err);
            alert("Error setting media");
        }
    }

    function loadVideo(url, startTime = 0) {
        if (!url) return;
        console.log("Loading Video:", url, "Target:", startTime);

        if (Hls.isSupported()) {
            hls = new Hls({
                debug: false, enableWorker: true, lowLatencyMode: true,
                startPosition: startTime > 0 ? startTime : -1
            });
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, function() {
                if (startTime > 0) video.currentTime = startTime;
                video.play().catch(e => console.log("Autoplay blocked"));
            });
            hls.on(Hls.Events.ERROR, function (event, data) {
                 if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.log("Network error, recovering...");
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.log("Media error, recovering...");
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

    // Initial Load
    if(INITIAL_MEDIA_URL) {
        loadVideo(INITIAL_MEDIA_URL);
    }
});