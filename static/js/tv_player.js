const socket = io();

const video = document.getElementById("video-player");
const channelTitle = document.getElementById("current-channel-name");
const statusText = document.getElementById("current-status-text");

let hls = null;
let currentChannelId = null;

/* ───────────────── INIT ───────────────── */

document.addEventListener("DOMContentLoaded", () => {
    loadChannels();
    setupChat();

    document.getElementById("search-box")
        .addEventListener("input", loadChannels);

    fetch("/api/status")
        .then(r => r.json())
        .then(data => {
            if (data.is_streaming && data.current_channel_id) {
                currentChannelId = data.current_channel_id;
                initPlayer();
            }
        });

    setInterval(() => {
        fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
    }, 5000);
});

/* ───────────────── PLAYER ───────────────── */

function initPlayer() {
    if (!currentChannelId) return;

    const url = `/static/stream/${currentChannelId}/index.m3u8?t=${Date.now()}`;

    video.pause();
    video.currentTime = 0;
    video.muted = true;
    video.autoplay = true;

    if (Hls.isSupported()) {
        if (hls) hls.destroy();

        hls = new Hls({
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 6
        });

        hls.loadSource(url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            safePlay();
        });

        hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) {
                console.warn("HLS error, retrying...");
                setTimeout(initPlayer, 3000);
            }
        });

    } else {
        video.src = url;
        safePlay();
    }
}

function safePlay() {
    video.muted = true;
    video.play().catch(() => {
        setTimeout(safePlay, 1000);
    });
}

function playChannel(id) {
    if (id === currentChannelId) return;

    currentChannelId = id;
    channelTitle.textContent = "Loading…";
    statusText.textContent = "Live";

    fetch(`/api/play/${id}`, { method: "POST" })
        .then(() => {
            loadChannels();
            setTimeout(initPlayer, 500);
        });
}

/* ───────────────── CHANNEL LIST ───────────────── */

function loadChannels() {
    fetch("/api/channels")
        .then(r => r.json())
        .then(channels => {
            const list = document.getElementById("channel-list");
            const favs = document.getElementById("favorites-list");
            const term = document.getElementById("search-box").value.toLowerCase();

            list.innerHTML = "";
            favs.innerHTML = "";

            channels.forEach(ch => {
                if (!ch.name.toLowerCase().includes(term)) return;

                const item = document.createElement("div");
                item.className = `channel-item ${ch.id === currentChannelId ? "active" : ""}`;
                item.onclick = () => playChannel(ch.id);
                item.innerHTML = `
                    <img class="ch-logo" src="${ch.logo || "/static/img/default_channel.png"}">
                    <span>${ch.name}</span>
                `;
                list.appendChild(item);

                if (ch.Favorites === true) {
                    const fav = document.createElement("div");
                    fav.className = "fav-card";
                    fav.onclick = () => playChannel(ch.id);
                    fav.innerHTML = `
                        <img class="fav-icon" src="${ch.logo || "/static/img/default_channel.png"}">
                        <span>${ch.name}</span>
                    `;
                    favs.appendChild(fav);
                }
            });
        });
}

/* ───────────────── CHAT ───────────────── */

function setupChat() {
    const input = document.getElementById("chat-input");
    const box = document.getElementById("chat-messages");
    const users = document.getElementById("users-list");
    const count = document.getElementById("user-count");

    document.getElementById("send-btn").onclick = send;

    input.addEventListener("keypress", e => {
        if (e.key === "Enter") send();
    });

    function send() {
        const msg = input.value.trim();
        if (!msg) return;
        socket.emit("chat_message", msg);
        input.value = "";
    }

    socket.on("chat_message", data => {
        const div = document.createElement("div");
        div.className = "msg";
        div.innerHTML = `<strong>${data.user}</strong>: ${data.text}`;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
    });

    socket.on("update_users", list => {
        users.innerHTML = "";
        count.textContent = list.length;
        list.forEach(u => {
            users.innerHTML += `<div class="user-row">${u}</div>`;
        });
    });
}
