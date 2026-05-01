const socket = io();
const channelLogo = document.getElementById("current-channel-logo");
const video = document.getElementById("video-player");
const channelTitle = document.getElementById("current-channel-name");

let hls = null;
let currentChannelId = null;
let chatInitialized = false;

/* ───────────────── INIT ───────────────── */

document.addEventListener("DOMContentLoaded", () => {
    // ✅ Initialize chat/users immediately
    setupChat();

    // ✅ Load channels/favorites immediately (fixes your “type then delete” bug)
    loadChannels();

    // ✅ Ask server for current online users once
    socket.emit("request_users");

    // ✅ If someone changes the channel, update everyone
    socket.on("channel_changed", (data) => {
        currentChannelId = data.channel_id;
        if (data.name) channelTitle.textContent = data.name;

        loadChannels();
        setTimeout(initPlayer, 300);
    });

    // Search should re-render list
    document.getElementById("search-box").addEventListener("input", loadChannels);

    // Get current stream status on load
    fetch("/api/status")
        .then(r => r.json())
        .then(data => {
            if (data.is_streaming && data.current_channel_id) {
                currentChannelId = data.current_channel_id;
                if (data.current_channel_name) channelTitle.textContent = data.current_channel_name;
            if (channelLogo && data.current_channel_logo) {
                    channelLogo.src = data.current_channel_logo;
                }
                // highlight active channel + populate lists on load
                loadChannels();
                initPlayer();
            }
        })
        .catch(() => {});

    // Heartbeat
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

function playChannel(id, name, logo) {
    if (id === currentChannelId) return;

    currentChannelId = id;

    // Show the channel immediately (no "Loading...")
    if (name) channelTitle.textContent = name;
    if (channelLogo) channelLogo.src = logo || "/static/img/default_channel.png";

    fetch(`/api/play/${id}`, { method: "POST" })
        .then(() => {
            loadChannels();
            setTimeout(initPlayer, 500);
        })
        .catch(() => {});
}

/* ───────────────── CHANNEL LIST ───────────────── */

function loadChannels() {
    fetch("/api/channels")
        .then(r => r.json())
        .then(channels => {
            const list = document.getElementById("channel-list");
            const favs = document.getElementById("favorites-list");

            // ✅ Fix: trim hidden whitespace so first-load doesn’t filter everything out
            const term = (document.getElementById("search-box").value || "").trim().toLowerCase();

            list.innerHTML = "";
            favs.innerHTML = "";

            channels.forEach(ch => {
                const nameLower = (ch.name || "").toLowerCase();

                // ✅ Only filter if term is not empty
                if (term && !nameLower.includes(term)) return;

                const item = document.createElement("div");
                item.className = `channel-item ${ch.id === currentChannelId ? "active" : ""}`;
                item.onclick = () => playChannel(ch.id, ch.name,ch.logo);
                item.innerHTML = `
                    <img class="ch-logo" src="${ch.logo || "/static/img/default_channel.png"}">
                    <span>${ch.name}</span>
                `;
                list.appendChild(item);

                if (ch.Favorites === true) {
                    const fav = document.createElement("div");
                    fav.className = "fav-card";
                    fav.onclick = () => playChannel(ch.id, ch.name,ch.logo);

                    fav.innerHTML = `
                        <img class="fav-icon" src="${ch.logo || "/static/img/default_channel.png"}" alt="${ch.name}">
                        <div class="fav-name">${ch.name}</div>
                    `;

                    favs.appendChild(fav);
                }
            });
        })
        .catch(() => {});
}

/* ───────────────── CHAT ───────────────── */

function setupChat() {
    // ✅ Prevent double-binding handlers if called again
    if (chatInitialized) return;
    chatInitialized = true;

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