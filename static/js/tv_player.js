const socket = io();
const videoElement = document.getElementById('videoPlayer');
const overlay = document.getElementById('loading-overlay');
const statusText = document.getElementById('connectionStatus');
let hls = null;
let currentChannelId = null;

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    loadChannels();
    setupChat();

    // Check initial state
    fetch('/api/status').then(r => r.json()).then(data => {
        if(data.is_streaming && data.current_channel_id) {
            currentChannelId = data.current_channel_id;
            loadChannels();
            initPlayer();
            updateStatus('active', `Streaming: ${data.name || 'Channel'}`);
        }
    });

    // Heartbeat
    setInterval(() => {
        fetch('/api/heartbeat', { method: 'POST' }).catch(()=>{});
    }, 5000);
});

// --- CORE PLAYER LOGIC ---
function initPlayer() {
    const streamUrl = `/stream/stream.m3u8?session=${Date.now()}`;

    setLoading(true, "Connecting...");

    if (Hls.isSupported()) {
        if(hls) { hls.destroy(); hls = null; }

        hls = new Hls({
            manifestLoadingTimeOut: 10000,
            enableWorker: true, // Better performance
            // OLD VERSION CACHE FIX
            xhrSetup: function(xhr, url) {
                const separator = url.includes('?') ? '&' : '?';
                xhr.open('GET', url + separator + 't=' + Date.now(), true);
            }
        });

        hls.loadSource(streamUrl);
        hls.attachMedia(videoElement);

        hls.on(Hls.Events.MANIFEST_PARSED, function() {
            setLoading(false);
            updateStatus('active', 'Live');
            videoElement.play().catch(e => {
                console.log("Autoplay blocked:", e);
                showClickToPlay();
            });
        });

        // ERROR RECOVERY (Restored)
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

    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        // iOS
        videoElement.src = streamUrl;
        videoElement.addEventListener('loadedmetadata', () => {
            setLoading(false);
            updateStatus('active', 'Live');
            videoElement.play().catch(e => showClickToPlay());
        }, { once: true });
    }
}

function playChannel(id) {
    if (currentChannelId === id) return;

    currentChannelId = id;
    loadChannels(); // Update UI active state

    setLoading(true, "Requesting Stream...");
    updateStatus('loading', 'Switching...');

    fetch(`/api/play/${id}`, { method: 'POST' })
        .then(r => r.json())
        .then(data => notify(data.message))
        .catch(err => notify("Failed to request channel"));
}

// --- UI HELPERS ---
function setLoading(isLoading, msg) {
    const txt = document.getElementById('overlay-text');
    if (isLoading) {
        overlay.classList.remove('hidden');
        overlay.innerHTML = `<div class="spinner"></div><h3>${msg}</h3>`;
        overlay.style.pointerEvents = 'none';
    } else {
        overlay.classList.add('hidden');
    }
}

function showClickToPlay() {
    overlay.classList.remove('hidden');
    overlay.style.pointerEvents = 'auto';
    overlay.innerHTML = `<h2>Stream Ready</h2><p>Click to Watch</p>`;
    overlay.onclick = () => {
        videoElement.play();
        videoElement.muted = false;
        overlay.classList.add('hidden');
    };
}

function updateStatus(state, text) {
    if(!statusText) return;
    const color = state === 'active' ? '#2ecc71' : (state === 'loading' ? '#f1c40f' : '#666');
    statusText.innerHTML = `<span style="color:${color}">●</span> ${text}`;
}

function notify(msg) {
    const n = document.getElementById('notification');
    n.innerText = msg;
    n.classList.add('show');
    setTimeout(() => n.classList.remove('show'), 3000);
}

function toggleFullscreen() {
    if (videoElement.requestFullscreen) videoElement.requestFullscreen();
    else if (videoElement.webkitEnterFullscreen) videoElement.webkitEnterFullscreen();
}

// --- DATA FETCHING ---
function loadChannels() {
    fetch('/api/channels')
        .then(r => r.json())
        .then(channels => {
            const list = document.getElementById('channelList');
            const favs = document.getElementById('favoritesRow');
            if(list) list.innerHTML = '';
            if(favs) favs.innerHTML = '';

            const searchTerm = document.getElementById('channelSearch').value.toLowerCase();

            channels.forEach(ch => {
                if(!ch.name.toLowerCase().includes(searchTerm)) return;

                // Main List
                const item = document.createElement('div');
                item.className = `channel-item ${currentChannelId == ch.id ? 'active' : ''}`;
                item.onclick = () => playChannel(ch.id);
                item.innerHTML = `
                    <img src="${ch.logo || '/static/img/default_channel.png'}" class="ch-logo">
                    <span>${ch.name}</span>
                `;
                list.appendChild(item);

                // Favorites
                if(ch.Favorites && favs) {
                    const fav = document.createElement('div');
                    fav.className = 'fav-card';
                    fav.onclick = () => playChannel(ch.id);
                    fav.innerHTML = `
                        <img src="${ch.logo || '/static/img/default_channel.png'}" class="fav-icon">
                        <span class="fav-name">${ch.name}</span>
                    `;
                    favs.appendChild(fav);
                }
            });
        });
}

// --- SEARCH & SOCKETS ---
document.getElementById('channelSearch').addEventListener('input', loadChannels);

function setupChat() {
    const chatInput = document.getElementById('chatInput');
    window.sendMessage = function() {
        const text = chatInput.value.trim();
        if(text) { socket.emit('chat_message', text); chatInput.value = ''; }
    }
    chatInput.addEventListener('keypress', (e) => { if(e.key === 'Enter') sendMessage(); });

    socket.on('chat_message', (data) => {
        const box = document.getElementById('chatMessages');
        const div = document.createElement('div');
        div.className = 'msg';
        div.innerHTML = `<span class="msg-user">${data.user}</span>${data.text}`;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
    });

    socket.on('update_users', (users) => {
        const list = document.getElementById('usersList');
        document.getElementById('userCount').innerText = users.length;
        list.innerHTML = '';
        users.forEach(u => {
            list.innerHTML += `<div class="user-row" style="padding:5px; display:flex; align-items:center; gap:8px;">
                <div style="background:#444; width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:0.8rem;">${u[0].toUpperCase()}</div>
                <span>${u}</span>
            </div>`;
        });
    });

    socket.on('channel_changed', (data) => {
        currentChannelId = data.channel_id;
        document.getElementById('currentProgramTitle').innerText = data.name;
        updateStatus('loading', 'Buffering...');
        notify(`Now Playing: ${data.name}`);
        loadChannels();

        // OLD VERSION TIMING (1.5s)
        setTimeout(() => initPlayer(), 1500);
    });
}