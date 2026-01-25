/**
 * tv_player.js - Refactored for PeakDecline Better Base
 * Fully robust version: Handles all data types for Favorites/Live status
 */

const socket = io();
const video = document.getElementById('video-player');
const overlay = document.getElementById('loading-overlay');
const statusText = document.getElementById('status-text');
const statusDot = document.getElementById('status-dot');
const onlineCountSpan = document.getElementById('online-count');
const userListContainer = document.getElementById('user-list');
const channelsContainer = document.getElementById('channels-container');
const favoritesContainer = document.getElementById('favorites-container');

let hls = null;
let channels = [];
let currentChannelId = null;
let isPlayerInitialized = false;

const STREAM_URL = '/stream/stream.m3u8';

// --- Initialization ---

// Clear any old service workers to prevent stream caching issues
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function(registrations) {
        for(let registration of registrations) { registration.unregister(); }
    });
}

// Start the app
loadChannels();

// --- Socket Events ---
socket.on('connect', () => {
    fetch('/api/status').then(r=>r.json()).then(data => handleStatusUpdate(data));
});

socket.on('channel_changed', (data) => {
    currentChannelId = data.channel_id;
    updateUI();
    setLoading(true, `Switching to ${getChannelName(currentChannelId)}...`);
    // Delay slightly to let the backend start the new ffmpeg process
    setTimeout(() => initPlayer(), 1500);
});

socket.on('stream_stopped', () => {
    currentChannelId = null;
    updateUI();
    setLoading(true, "Stream Stopped");
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    video.load();
});

socket.on('status', (data) => handleStatusUpdate(data));

// --- Core Functions ---
async function loadChannels() {
    try {
        const res = await fetch('/api/channels');
        channels = await res.json();
        renderChannels();
    } catch(e) { console.error("Load Error:", e); }
}

function renderChannels() {
    const searchEl = document.getElementById('search');
    const term = searchEl ? searchEl.value.toLowerCase() : '';

    // Safety check: Don't crash if HTML elements aren't ready
    if (!channelsContainer || !favoritesContainer) return;

    const filtered = channels.filter(c => c.name.toLowerCase().includes(term));

    // Robust check: handles '1' (string), 1 (int), or true (boolean)
    const favorites = filtered.filter(c => c.Favorites == '1' || c.Favorites == 1 || c.Favorites === true);

    // 1. Render Favorites (Left Sidebar - Compact List)
    if(favorites.length > 0) {
        favoritesContainer.innerHTML = favorites.map(c => `
            <div class="channel-card sidebar-card ${c.id == currentChannelId ? 'playing' : ''}" onclick="playChannel(${c.id})">
                <h3>${c.name}</h3>
                <button class="fav-star" onclick="event.stopPropagation(); toggleFavorite(${c.id})">⭐</button>
            </div>
        `).join('');
    } else {
        favoritesContainer.innerHTML = '<div class="empty-msg" style="padding:10px; opacity:0.6; font-style:italic;">No favorites yet</div>';
    }

    // 2. Render Main Grid (Center - Full Cards)
    if(filtered.length > 0) {
        channelsContainer.innerHTML = filtered.map(c => {
            // Check Live status (robust)
            const isLive = c.is_playing == '1' || c.is_playing === true;
            // Check Favorite status (robust)
            const isFav = c.Favorites == '1' || c.Favorites == 1 || c.Favorites === true;

            return `
            <div class="channel-card ${c.id == currentChannelId ? 'playing' : ''}" onclick="playChannel(${c.id})">
                <div class="card-body">
                    <h3>${c.name}</h3>
                    <small>${c.url}</small>
                </div>
                ${isLive ? '<div class="live-indicator">LIVE</div>' : ''}
                <button class="fav-star" onclick="event.stopPropagation(); toggleFavorite(${c.id})">
                    ${isFav ? '⭐' : '☆'}
                </button>
            </div>
            `;
        }).join('');
    } else {
        channelsContainer.innerHTML = '<div class="empty-msg" style="text-align:center; padding:20px;">No channels found</div>';
    }
}

async function playChannel(id) {
    if (id === currentChannelId) {
        // Just unmute if clicking current channel
        video.muted = false;
        return;
    }
    setLoading(true, "Requesting Stream...");
    try {
        await fetch(`/api/play/${id}`, { method: 'POST' });
    } catch(e) {
        console.error(e);
        notify("Failed to change channel");
        setLoading(false);
    }
}

function initPlayer() {
    isPlayerInitialized = true;
    if (hls) { hls.destroy(); hls = null; }

    // Add timestamp to prevent caching old segments
    const uniqueSrc = `${STREAM_URL}?session=${Date.now()}`;

    if (Hls.isSupported()) {
        hls = new Hls({
            manifestLoadingTimeOut: 10000,
            enableWorker: false
        });
        hls.loadSource(uniqueSrc);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setLoading(false);
            video.play().catch(() => showClickToPlay());
            const name = getChannelName(currentChannelId);
            setStatus('active', `Streaming: ${name}`);
        });
        hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                 if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    console.log("Network error, trying to recover...");
                    hls.startLoad();
                 } else {
                    hls.destroy();
                 }
            }
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS support (Safari)
        video.src = uniqueSrc;
        video.addEventListener('loadedmetadata', () => {
            setLoading(false);
            video.play().catch(() => showClickToPlay());
        }, { once: true });
    }
}

// --- Utilities ---
function handleStatusUpdate(data) {
    if (data.is_streaming && data.current_channel_id) {
        currentChannelId = data.current_channel_id;
        updateUI();
        const name = getChannelName(currentChannelId);
        setStatus('active', `Streaming: ${name}`);

        if (!isPlayerInitialized) {
            setLoading(true, `Joining ${name}...`);
            initPlayer();
        }
    } else {
        setStatus('idle', 'Ready');
    }
}

function setLoading(isLoading, msg) {
    if (!overlay) return;
    if (isLoading) {
        overlay.classList.remove('hidden');
        overlay.innerHTML = `<div class="spinner"></div><h3>${msg}</h3>`;
        // disable click-to-play while loading
        overlay.onclick = null;
    } else {
        overlay.classList.add('hidden');
    }
}

function showClickToPlay() {
    if(!overlay) return;
    overlay.classList.remove('hidden');
    overlay.innerHTML = `<h2>Stream Ready</h2><p>Click to Watch</p>`;
    overlay.onclick = () => {
        video.play();
        video.muted = false;
        overlay.classList.add('hidden');
    };
}

function setStatus(state, text) {
    if(statusText) statusText.innerText = text;
    if(statusDot) statusDot.className = `live-dot ${state}`;
}

function notify(msg) {
    const n = document.getElementById('notification');
    if(!n) return;
    n.innerText = msg; n.classList.add('show');
    setTimeout(() => n.classList.remove('show'), 3000);
}

function updateUI() { renderChannels(); }

window.filterChannels = () => renderChannels();
window.toggleFullscreen = () => {
    if (video.requestFullscreen) video.requestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
};

window.toggleFavorite = async (id) => {
    const chan = channels.find(c => c.id === id);
    if(chan) {
        // Toggle the value (works for boolean, converts 0/1 to boolean)
        chan.Favorites = !chan.Favorites;
        renderChannels();
        // Future: Add fetch call here to save to database
    }
};

function getChannelName(id) {
    if (!channels.length) return "Loading...";
    const found = channels.find(c => c.id === id);
    return found ? found.name : 'Unknown Channel';
}

// --- Polling Loops ---
setInterval(() => {
    // Heartbeat to keep session alive
    fetch('/api/heartbeat', {method:'POST'}).catch(()=>{});

    // Update Online Users
    fetch('/api/online_users')
        .then(r => r.json())
        .then(users => {
            if (onlineCountSpan) onlineCountSpan.innerText = users.length;
            if (userListContainer) {
                userListContainer.innerHTML = users.map(u => `
                    <div class="user-item">
                        <span class="user-avatar">👤</span>
                        <span>${u}</span>
                    </div>
                `).join('');
            }
        })
        .catch(e => console.error("User fetch error:", e));
}, 5000);