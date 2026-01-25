const socket = io();
const video = document.getElementById('videoPlayer');
let hls = null;
let currentChannelId = null;

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    loadChannels();
    setupChat();
    
    // Check if we were already playing something (on refresh)
    fetch('/api/status').then(r => r.json()).then(data => {
        if(data.is_streaming && data.current_channel_id) {
            currentChannelId = data.current_channel_id;
            loadChannels(); // Refresh UI to show active channel
            initPlayer();
        }
    });

    // Start Heartbeat Loop
    setInterval(() => {
        fetch('/api/heartbeat', { method: 'POST' });
    }, 5000); // Every 5 seconds
});

// --- CHANNEL LIST & UI ---
function loadChannels() {
    fetch('/api/channels')
        .then(r => r.json())
        .then(channels => {
            const listContainer = document.getElementById('channelList');
            const favContainer = document.getElementById('favoritesRow');
            
            listContainer.innerHTML = '';
            favContainer.innerHTML = '';

            channels.forEach(ch => {
                // 1. Create Main List Item
                const item = document.createElement('div');
                item.className = 'channel-item';
                item.setAttribute('data-name', ch.name.toLowerCase());
                item.onclick = () => playChannel(ch.id);
                
                // Add active class if playing
                if (currentChannelId && ch.id == currentChannelId) {
                    item.classList.add('active');
                    document.getElementById('currentProgramTitle').innerText = ch.name;
                }

                item.innerHTML = `
                    <img src="${ch.logo || '/static/img/default_channel.png'}" class="ch-logo" onerror="this.src='/static/img/default_channel.png'">
                    <span>${ch.name}</span>
                `;
                listContainer.appendChild(item);

                // 2. Create Favorite Item (if favorite)
                if(ch.Favorites) {
                    const fav = document.createElement('div');
                    fav.className = 'fav-card';
                    fav.onclick = () => playChannel(ch.id);
                    fav.innerHTML = `
                        <img src="${ch.logo || '/static/img/default_channel.png'}" class="fav-icon" onerror="this.src='/static/img/default_channel.png'">
                        <span class="fav-name">${ch.name}</span>
                    `;
                    favContainer.appendChild(fav);
                }
            });
        });
}

// --- PLAYBACK LOGIC ---
function playChannel(id) {
    if (currentChannelId === id) return; // Already playing

    // Update UI immediately for responsiveness
    currentChannelId = id;
    loadChannels(); 
    
    // Show Loading
    document.getElementById('currentProgramTitle').innerText = "Starting Stream...";

    // Call API
    fetch(`/api/play/${id}`, { method: 'POST' })
        .then(r => r.json())
        .then(data => {
            console.log(data.message);
            // The socket event 'channel_changed' will actually trigger the video player
        });
}

function initPlayer() {
    const streamUrl = `/stream/stream.m3u8?session=${Date.now()}`;

    if (Hls.isSupported()) {
        if(hls) hls.destroy();
        
        hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 60
        });
        
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, function() {
            video.play().catch(e => console.log("Autoplay blocked:", e));
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = streamUrl;
        video.play();
    }
}

// --- SEARCH FILTER ---
document.getElementById('channelSearch').addEventListener('keyup', (e) => {
    const term = e.target.value.toLowerCase();
    document.querySelectorAll('.channel-item').forEach(item => {
        const name = item.getAttribute('data-name');
        item.style.display = name.includes(term) ? 'flex' : 'none';
    });
});

// --- CHAT & USERS LOGIC ---
function setupChat() {
    const chatInput = document.getElementById('chatInput');
    
    window.sendMessage = function() {
        const text = chatInput.value.trim();
        if(!text) return;
        socket.emit('chat_message', text);
        chatInput.value = '';
    }
    
    chatInput.addEventListener('keypress', (e) => {
        if(e.key === 'Enter') sendMessage();
    });

    // Listen for Messages
    socket.on('chat_message', (data) => {
        const box = document.getElementById('chatMessages');
        const div = document.createElement('div');
        div.className = 'msg';
        div.innerHTML = `<span class="msg-user">${data.user}</span>${data.text}`;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
    });

    // Listen for User Updates
    socket.on('update_users', (users) => {
        const list = document.getElementById('usersList');
        document.getElementById('userCount').innerText = users.length;
        list.innerHTML = '';
        users.forEach(u => {
            const initial = u.charAt(0).toUpperCase();
            const html = `
                <div class="user-row">
                    <div class="user-avatar">${initial}</div>
                    <div class="user-name">${u}</div>
                    <div class="status-dot"></div>
                </div>
            `;
            list.innerHTML += html;
        });
    });

    // Listen for Channel Changes (from other users or self)
    socket.on('channel_changed', (data) => {
        console.log("Channel changed:", data);
        currentChannelId = data.channel_id;
        document.getElementById('currentProgramTitle').innerText = data.name;
        loadChannels(); // Updates highlight
        
        // Wait 5 seconds (Safety Buffer) before asking for video
        setTimeout(() => initPlayer(), 5000);
    });
}