/* static/js/room_player.js */

document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Room Player Loaded (Custom Watch Together Player)');

    // ==========================================
    // 1. CONFIG & ROOM STATE
    // ==========================================

    const appContainer = document.getElementById('room-app');

    if (!appContainer) {
        console.error('CRITICAL: Room App container not found!');
        return;
    }

    const ROOM_ID = appContainer.dataset.roomId;

    let CURRENT_KEY = appContainer.dataset.currentKey || '';

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
    let currentMediaUrl = '';

    const PLEX_PROGRESS_INTERVAL_MS = 10000;
    const SYNCED_THRESHOLD_SECONDS = 0.5;
    const MANUAL_SYNC_THRESHOLD_SECONDS = 2.0;

    const NEXT_EPISODE_COUNTDOWN_SECONDS = 10;

    let nextEpisodeCountdownTimer = null;
    let nextEpisodeCandidate = null;
    let nextEpisodeSourceKey = '';

    let localVolume = Number(
        localStorage.getItem('watchPartyVolume') || 1
    );

    let localMuted =
        localStorage.getItem('watchPartyMuted') === 'true';

    let isPlayerScrubbing = false;

    // ==========================================
    // 2. WEBRTC / EMULATOR STATE
    // ==========================================

    let peerConnections = {};
    let localStream = null;

    let emulatorLoaderScript = null;
    let emulatorBootInterval = null;

    let localGameVolume = Number(
        localStorage.getItem('watchPartyGameVolume') || 1
    );

    let localGameMuted =
        localStorage.getItem('watchPartyGameMuted') === 'true';


    /*
     * IMPORTANT:
     * Put your EXISTING TURN values back into this block.
     *
     * I am intentionally not reproducing credentials from the repository.
     */
    const ICE_SERVERS = {
        iceServers: [
            {
                urls: 'stun:stun.l.google.com:19302'
            },
            {
                urls: 'stun:stun1.l.google.com:19302'
            },
            {
                urls: [
                    'turn:YOUR_TURN_HOST:3478?transport=udp',
                    'turn:YOUR_TURN_HOST:3478?transport=tcp'
                ],
                username: 'YOUR_TURN_USERNAME',
                credential: 'YOUR_TURN_CREDENTIAL'
            }
        ],

        // Keep relay while testing TURN.
        // Switch to "all" later if you want direct WebRTC when possible.
        iceTransportPolicy: 'relay'
    };


    // ==========================================
    // 3. ELEMENT SELECTION
    // ==========================================

    const openSearchBtn =
        document.getElementById('btn-open-search');

    const btnOpenGames =
        document.getElementById('btn-open-games');

    const btnStartBroadcast =
        document.getElementById('btn-start-broadcast');

    const btnStopGame =
        document.getElementById('btn-stop-game');


    // Plex player
    const video =
        document.getElementById('video-player');

    const plexPlayerShell =
        document.getElementById('plex-player-shell');

    const plexPlayerControls =
        document.getElementById('plex-player-controls');

    const plexPlayToggle =
        document.getElementById('plex-play-toggle');

    const plexMuteToggle =
        document.getElementById('plex-mute-toggle');

    const plexVolume =
        document.getElementById('plex-volume');

    const plexPlayerProgress =
        document.getElementById('plex-player-progress');

    const plexPlayerTime =
        document.getElementById('plex-player-time');

    const plexSyncStatus =
        document.getElementById('plex-sync-status');

    const btnSyncToHost =
        document.getElementById('btn-sync-to-host');

    const plexFullscreenToggle =
        document.getElementById('plex-fullscreen-toggle');


    // Main stage
    const mainVideoWrapper =
        document.getElementById('main-video-wrapper');

    const gameContainer =
        document.getElementById('game-container');

    const remoteVideo =
        document.getElementById('remote-video');

    const mediaTitleElem =
        document.getElementById('media-title');


    // Plex settings
    const mediaSettingsCog =
        document.getElementById('media-settings-cog');

    const mediaSettingsPanel =
        document.getElementById('media-settings-panel');

    const audioTrackSelect =
        document.getElementById('audio-track-select');

    const subtitleTrackSelect =
        document.getElementById('subtitle-track-select');

    const videoQualitySelect =
        document.getElementById('video-quality-select');

    const btnApplyTracks =
        document.getElementById('btn-apply-tracks');


    // Next episode
    const nextEpisodeOverlay =
        document.getElementById('next-episode-overlay');

    const nextEpisodeTitle =
        document.getElementById('next-episode-title');

    const nextEpisodeCountdown =
        document.getElementById('next-episode-countdown');

    const btnNextEpisodePlay =
        document.getElementById('btn-next-episode-play');

    const btnNextEpisodeCancel =
        document.getElementById('btn-next-episode-cancel');


    // Chat
    const chatBox =
        document.getElementById('chat-box');

    const chatInput =
        document.getElementById('chat-input');

    const sendBtn =
        document.getElementById('btn-send-chat');


    // Plex search
    const searchModal =
        document.getElementById('searchModal');

    const closeSearchBtn =
        document.getElementById('btn-close-search');

    const searchPlexBtn =
        document.getElementById('btn-search-plex');

    const searchInput =
        document.getElementById('plex-search-input');

    const resultsContainer =
        document.getElementById('search-results');


    // Games
    const gameModal =
        document.getElementById('gameModal');

    const closeGamesBtn =
        document.getElementById('btn-close-games');

    const gameResults =
        document.getElementById('game-results');


    // ==========================================
    // 4. LOCAL UI STATE
    // ==========================================

    let navigationStack = [];

    let currentUIState = 'plex';

    let controlsHideTimer = null;

    let trackOptionsLoadedForKey = '';


    const allowedVideoBitrates = new Set([
        '0',
        '20000',
        '12000',
        '8000',
        '4000',
        '2000'
    ]);


    const savedVideoBitrate =
        localStorage.getItem('watchPartyVideoBitrate')
        || '8000';


    if (videoQualitySelect) {
        videoQualitySelect.value =
            allowedVideoBitrates.has(savedVideoBitrate)
                ? savedVideoBitrate
                : '8000';

        videoQualitySelect.addEventListener(
            'change',
            () => {
                const value =
                    videoQualitySelect.value;

                if (
                    allowedVideoBitrates.has(value)
                ) {
                    localStorage.setItem(
                        'watchPartyVideoBitrate',
                        value
                    );
                }
            }
        );
    }


    // ==========================================
    // 5. CUSTOM PLAYER HELPERS
    // ==========================================

    function formatPlayerTime(seconds) {
        const total = Math.max(
            0,
            Math.floor(Number(seconds) || 0)
        );

        const hours =
            Math.floor(total / 3600);

        const minutes =
            Math.floor(
                (total % 3600) / 60
            );

        const secs =
            total % 60;


        if (hours > 0) {
            return (
                `${hours}:`
                + `${String(minutes).padStart(2, '0')}:`
                + `${String(secs).padStart(2, '0')}`
            );
        }

        return (
            `${minutes}:`
            + `${String(secs).padStart(2, '0')}`
        );
    }


    function updateCustomPlayerUI() {
        if (!video) {
            return;
        }


        const duration =
            Number.isFinite(video.duration)
                ? video.duration
                : 0;


        const currentTime =
            Number.isFinite(video.currentTime)
                ? video.currentTime
                : 0;


        if (
            plexPlayerProgress
            && !isPlayerScrubbing
        ) {
            plexPlayerProgress.max =
                duration > 0
                    ? duration
                    : 0;

            plexPlayerProgress.value =
                duration > 0
                    ? Math.min(
                        currentTime,
                        duration
                    )
                    : 0;
        }


        if (plexPlayerTime) {
            plexPlayerTime.textContent =
                `${formatPlayerTime(currentTime)} / `
                + `${formatPlayerTime(duration)}`;
        }


        if (plexPlayToggle) {
            plexPlayToggle.textContent =
                video.paused
                    ? '▶'
                    : '❚❚';

            plexPlayToggle.setAttribute(
                'aria-label',
                video.paused
                    ? 'Play'
                    : 'Pause'
            );
        }


        if (plexMuteToggle) {
            plexMuteToggle.textContent =
                (
                    video.muted
                    || video.volume === 0
                )
                    ? '🔇'
                    : '🔊';
        }


        if (plexVolume) {
            plexVolume.value =
                video.muted
                    ? '0'
                    : String(video.volume);
        }


        if (
            plexPlayerShell
            && video.paused
            && currentUIState === 'plex'
        ) {
            plexPlayerShell.classList.add(
                'controls-visible'
            );
        }
    updatePlexSyncStatus();
    }


    function getExpectedRoomTime() {
        if (!roomIsPlaying) {
            return Number(
                mediaOffset || 0
            );
        }

        return (
            (
                (Date.now() / 1000)
                - localSyncStartTime
            )
            + mediaOffset
        );
    }

    function updatePlexSyncStatus() {
        const hasPlexMedia =
            (
                currentUIState === 'plex'
                && !!CURRENT_KEY
                && !!currentMediaUrl
                && !!video
            );

        if (!hasPlexMedia) {
            if (plexSyncStatus) {
                plexSyncStatus.style.display = 'none';
            }

            if (btnSyncToHost) {
                btnSyncToHost.style.display = 'none';
            }

            return;
        }

        // Host is the synchronization source.
        if (isHost) {
            if (plexSyncStatus) {
                plexSyncStatus.style.display = 'inline-flex';
                plexSyncStatus.textContent = 'Host';
                plexSyncStatus.dataset.state = 'host';
            }

            if (btnSyncToHost) {
                btnSyncToHost.style.display = 'none';
            }

            return;
        }

        if (!plexSyncStatus) {
            return;
        }

        plexSyncStatus.style.display = 'inline-flex';

        // Viewer intentionally paused locally.
        if (
            roomIsPlaying
            && video.paused
        ) {
            plexSyncStatus.textContent = 'Paused locally';
            plexSyncStatus.dataset.state = 'paused';

            if (btnSyncToHost) {
                btnSyncToHost.style.display = 'inline-flex';
            }

            return;
        }

        const expectedTime =
            getExpectedRoomTime();

        const actualTime =
            Number(video.currentTime || 0);

        if (
            !Number.isFinite(expectedTime)
            || !Number.isFinite(actualTime)
        ) {
            plexSyncStatus.textContent = 'Syncing';
            plexSyncStatus.dataset.state = 'syncing';

            if (btnSyncToHost) {
                btnSyncToHost.style.display = 'none';
            }

            return;
        }

        const drift =
            expectedTime - actualTime;

        const absoluteDrift =
            Math.abs(drift);

        if (
            absoluteDrift
            <= SYNCED_THRESHOLD_SECONDS
        ) {
            plexSyncStatus.textContent = 'Synced';
            plexSyncStatus.dataset.state = 'synced';

            if (btnSyncToHost) {
                btnSyncToHost.style.display = 'none';
            }

            return;
        }

        const sign =
            drift >= 0
                ? '+'
                : '−';

        plexSyncStatus.textContent =
            `Syncing ${sign}${absoluteDrift.toFixed(1)}s`;

        if (
            absoluteDrift
            >= MANUAL_SYNC_THRESHOLD_SECONDS
        ) {
            plexSyncStatus.dataset.state =
                'out-of-sync';

            if (btnSyncToHost) {
                btnSyncToHost.style.display =
                    'inline-flex';
            }
        } else {
            plexSyncStatus.dataset.state =
                'syncing';

            if (btnSyncToHost) {
                btnSyncToHost.style.display =
                    'none';
            }
        }
    }

    function syncViewerToHost() {
        if (isHost) {
            return;
        }

        if (!video) {
            return;
        }

        if (!currentMediaUrl) {
            return;
        }


        const expectedTime =
            getExpectedRoomTime();


        if (
            !Number.isFinite(expectedTime)
        ) {
            return;
        }


        isSystemAction = true;


        try {
            video.currentTime =
                Math.max(
                    0,
                    expectedTime
                );
        } catch (e) {}


        if (roomIsPlaying) {
            video.play().catch(
                err => {
                    console.warn(
                        'Viewer sync play blocked:',
                        err
                    );
                }
            );
        } else {
            try {
                video.pause();
            } catch (e) {}
        }


        setTimeout(
            () => {
                isSystemAction = false;
            },
            150
        );


        updateCustomPlayerUI();
        updatePlexSyncStatus();

    }


    function togglePlexPlayback() {
        if (
            !video
            || !currentMediaUrl
        ) {
            return;
        }


        if (video.paused) {
            video.play().catch(
                err => {
                    console.warn(
                        'Could not start playback:',
                        err
                    );
                }
            );
        } else {
            video.pause();
        }
    }


    function seekHostPlayer(targetTime) {
        if (!isHost) {
            return;
        }

        if (!video) {
            return;
        }


        const duration =
            Number.isFinite(video.duration)
                ? video.duration
                : 0;


        if (duration <= 0) {
            return;
        }


        const target =
            Math.min(
                duration,
                Math.max(
                    0,
                    Number(targetTime) || 0
                )
            );


        isSystemAction = true;


        try {
            video.currentTime = target;
        } catch (e) {}


        /*
         * Re-anchor the sync clock immediately.
         * Otherwise the host's own sync loop can interpret
         * the seek as drift.
         */
        setPlaybackClock(
            Date.now() / 1000,
            target
        );


        if (socket) {
            socket.emit(
                'user_seek',
                {
                    room_id: ROOM_ID,
                    current_time: target,
                    is_playing: !video.paused
                }
            );
        }


        reportPlexProgress(
            video.paused
                ? 'paused'
                : 'playing'
        );


        setTimeout(
            () => {
                isSystemAction = false;
            },
            150
        );


        updateCustomPlayerUI();
    }

    setInterval(
    () => {
        updatePlexSyncStatus();
    },
    500
);
    // ==========================================
    // 6. UI STATE MANAGER
    // ==========================================

    function setUIState(state) {
        currentUIState = state;

        hideMediaSettingsPanel();


        if (plexPlayerShell) {
            plexPlayerShell.style.display =
                'none';
        } else if (video) {
            video.style.display =
                'none';
        }


        if (gameContainer) {
            gameContainer.style.display =
                'none';
        }


        if (remoteVideo) {
            remoteVideo.style.display =
                'none';
        }


        if (btnStopGame) {
            btnStopGame.style.display =
                'none';
        }


        if (btnStartBroadcast) {
            btnStartBroadcast.style.display =
                'none';
        }


        if (state === 'plex') {

            if (plexPlayerShell) {
                plexPlayerShell.style.display =
                    'block';
            }

            if (video) {
                video.style.display =
                    'block';

                /*
                 * Plex uses our custom controls.
                 */
                video.removeAttribute(
                    'controls'
                );

                video.style.pointerEvents =
                    'auto';
            }

        } else if (
            state === 'emulator-host'
        ) {

            if (gameContainer) {
                gameContainer.style.display =
                    'block';
            }

            if (
                isHost
                && btnStopGame
            ) {
                btnStopGame.style.display =
                    'inline-block';
            }

            if (
                isHost
                && btnStartBroadcast
            ) {
                btnStartBroadcast.style.display =
                    'inline-block';
            }

        } else if (
            state === 'emulator-viewer'
        ) {

            if (remoteVideo) {
                remoteVideo.style.display =
                    'block';

                remoteVideo.setAttribute(
                    'controls',
                    'controls'
                );

                remoteVideo.style.pointerEvents =
                    'auto';
            }
        }


        updateMediaSettingsVisibility();
        updateCustomPlayerUI();
    }


    function applyHostPermissions() {
        /*
         * Plex always uses the custom controls.
         */
        if (video) {
            video.removeAttribute(
                'controls'
            );

            video.style.pointerEvents =
                'auto';
        }


        /*
         * Emulator/WebRTC still uses the browser controls.
         */
        if (remoteVideo) {
            remoteVideo.setAttribute(
                'controls',
                'controls'
            );

            remoteVideo.style.pointerEvents =
                'auto';
        }


        if (isHost) {
            if (openSearchBtn) {
                openSearchBtn.style.display =
                    'inline-block';
            }

            if (btnOpenGames) {
                btnOpenGames.style.display =
                    'inline-block';
            }

        } else {

            if (openSearchBtn) {
                openSearchBtn.style.display =
                    'none';
            }

            if (btnOpenGames) {
                btnOpenGames.style.display =
                    'none';
            }

            if (btnStartBroadcast) {
                btnStartBroadcast.style.display =
                    'none';
            }

            if (btnStopGame) {
                btnStopGame.style.display =
                    'none';
            }
        }


        updateMediaSettingsVisibility();
        updateCustomPlayerUI();
    }


    function updateMediaSettingsVisibility() {
        const hasPlexMedia =
            (
                currentUIState === 'plex'
                && !!CURRENT_KEY
                && !!currentMediaUrl
            );


        if (mediaSettingsCog) {
            mediaSettingsCog.style.display =
                (
                    isHost
                    && hasPlexMedia
                )
                    ? 'inline-flex'
                    : 'none';
        }

        updatePlexSyncStatus();


        if (plexPlayerProgress) {
            plexPlayerProgress.disabled =
                (
                    !isHost
                    || !hasPlexMedia
                );

            plexPlayerProgress.classList.toggle(
                'viewer-readonly',
                !isHost
            );
        }


        if (
            !isHost
            || !hasPlexMedia
        ) {
            hideMediaSettingsPanel();
        }
    }


    function hideMediaSettingsPanel() {
        if (mediaSettingsPanel) {
            mediaSettingsPanel.style.display =
                'none';
        }

        if (mediaSettingsCog) {
            mediaSettingsCog.classList.remove(
                'panel-open'
            );
        }
    }


    function showMediaControlsOverlay() {
        if (!plexPlayerShell) {
            return;
        }

        if (
            currentUIState !== 'plex'
        ) {
            return;
        }


        plexPlayerShell.classList.add(
            'controls-visible'
        );


        clearTimeout(
            controlsHideTimer
        );


        controlsHideTimer =
            setTimeout(
                () => {
                    const settingsOpen =
                        (
                            mediaSettingsPanel
                            && mediaSettingsPanel.style.display === 'flex'
                        );


                    if (settingsOpen) {
                        return;
                    }


                    if (
                        video
                        && video.paused
                    ) {
                        return;
                    }


                    plexPlayerShell.classList.remove(
                        'controls-visible'
                    );

                },
                2500
            );
    }


    // ==========================================
    // 7. LOCAL VOLUME MEMORY
    // ==========================================

    if (video) {
        video.volume =
            Math.min(
                1,
                Math.max(
                    0,
                    localVolume
                )
            );

        video.muted =
            localMuted;


        video.addEventListener(
            'volumechange',
            () => {
                localVolume =
                    video.volume;

                localMuted =
                    video.muted;


                localStorage.setItem(
                    'watchPartyVolume',
                    String(localVolume)
                );

                localStorage.setItem(
                    'watchPartyMuted',
                    String(localMuted)
                );


                updateCustomPlayerUI();
            }
        );
    }


    if (remoteVideo) {
        remoteVideo.volume =
            Math.min(
                1,
                Math.max(
                    0,
                    localGameVolume
                )
            );

        remoteVideo.muted =
            localGameMuted;


        remoteVideo.setAttribute(
            'controls',
            'controls'
        );

        remoteVideo.style.pointerEvents =
            'auto';


        remoteVideo.addEventListener(
            'volumechange',
            () => {
                localGameVolume =
                    remoteVideo.volume;

                localGameMuted =
                    remoteVideo.muted;


                localStorage.setItem(
                    'watchPartyGameVolume',
                    String(localGameVolume)
                );

                localStorage.setItem(
                    'watchPartyGameMuted',
                    String(localGameMuted)
                );
            }
        );


        /*
         * Viewer pause/play of the WebRTC stream
         * remains local only.
         */
        remoteVideo.addEventListener(
            'pause',
            () => {}
        );

        remoteVideo.addEventListener(
            'play',
            () => {}
        );
    }


    // ==========================================
    // 8. TRACK / QUALITY HELPERS
    // ==========================================

    function formatTrackLabel(
        track,
        fallback
    ) {
        if (!track) {
            return fallback;
        }


        const parts = [];


        if (track.language) {
            parts.push(
                track.language
            );
        }


        if (
            track.title
            && !parts.includes(track.title)
        ) {
            parts.push(
                track.title
            );
        }


        return (
            parts.join(' - ')
            || fallback
        );
    }


    function populateTrackSelect(
        selectElem,
        tracks,
        fallbackText
    ) {
        if (!selectElem) {
            return;
        }


        selectElem.innerHTML = '';


        if (
            !Array.isArray(tracks)
            || tracks.length === 0
        ) {
            const option =
                document.createElement(
                    'option'
                );

            option.value = '';

            option.textContent =
                fallbackText;

            selectElem.appendChild(
                option
            );

            return;
        }


        tracks.forEach(
            track => {
                const option =
                    document.createElement(
                        'option'
                    );

                option.value =
                    track.id == null
                        ? ''
                        : String(track.id);

                option.textContent =
                    formatTrackLabel(
                        track,
                        fallbackText
                    );


                if (track.selected) {
                    option.selected = true;
                }


                selectElem.appendChild(
                    option
                );
            }
        );
    }


    async function loadTrackOptions(
        ratingKey,
        forceReload = false
    ) {
        if (
            !isHost
            || !ratingKey
            || !audioTrackSelect
            || !subtitleTrackSelect
        ) {
            return;
        }


        if (
            !forceReload
            && trackOptionsLoadedForKey
                === String(ratingKey)
        ) {
            return;
        }


        trackOptionsLoadedForKey =
            String(ratingKey);


        try {
            populateTrackSelect(
                audioTrackSelect,
                [],
                'Loading audio...'
            );

            populateTrackSelect(
                subtitleTrackSelect,
                [],
                'Loading subtitles...'
            );


            const response =
                await fetch(
                    `/api/plex/metadata/${encodeURIComponent(ratingKey)}`
                );


            const data =
                await response.json();


            if (
                !response.ok
                || data.error
            ) {
                throw new Error(
                    data.error
                    || 'Could not load Plex metadata.'
                );
            }


            populateTrackSelect(
                audioTrackSelect,
                data.audio || [],
                'Default Audio'
            );


            populateTrackSelect(
                subtitleTrackSelect,
                data.subtitles || [],
                'Off'
            );

        } catch (err) {
            console.error(
                'Error loading audio/subtitle options:',
                err
            );


            trackOptionsLoadedForKey = '';


            populateTrackSelect(
                audioTrackSelect,
                [],
                'Audio unavailable'
            );


            populateTrackSelect(
                subtitleTrackSelect,
                [],
                'Subtitles unavailable'
            );
        }
    }


    async function applySelectedTracks() {
        if (
            !isHost
            || !CURRENT_KEY
        ) {
            return;
        }


        const audioStreamId =
            audioTrackSelect
                ? audioTrackSelect.value
                : null;


        const subtitleStreamId =
            subtitleTrackSelect
                ? subtitleTrackSelect.value
                : '';


        const currentTime =
            video
                ? (
                    video.currentTime
                    || mediaOffset
                    || 0
                )
                : (
                    mediaOffset
                    || 0
                );


        const maxVideoBitrate =
            videoQualitySelect
                ? videoQualitySelect.value
                : '8000';


        const payload = {
            rating_key: CURRENT_KEY,
            audio_stream_id: audioStreamId,
            subtitle_stream_id: subtitleStreamId,
            max_video_bitrate: maxVideoBitrate,
            view_offset: currentTime
        };


        if (
            allowedVideoBitrates.has(
                maxVideoBitrate
            )
        ) {
            localStorage.setItem(
                'watchPartyVideoBitrate',
                maxVideoBitrate
            );
        }


        if (btnApplyTracks) {
            btnApplyTracks.disabled =
                true;

            btnApplyTracks.textContent =
                'Applying...';
        }


        try {
            const response =
                await fetch(
                    `/api/room/${ROOM_ID}/set_media`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type':
                                'application/json'
                        },
                        body:
                            JSON.stringify(
                                payload
                            )
                    }
                );


            const data =
                await response.json();


            if (
                !response.ok
                || !data.success
            ) {
                throw new Error(
                    data.error
                    || 'Error changing audio/subtitles'
                );
            }


            hideMediaSettingsPanel();
            showMediaControlsOverlay();

        } catch (err) {
            console.error(
                'Error applying audio/subtitle tracks:',
                err
            );

            alert(
                'Error changing audio/subtitles: '
                + err.message
            );

        } finally {

            if (btnApplyTracks) {
                btnApplyTracks.disabled =
                    false;

                btnApplyTracks.textContent =
                    'Apply to Room';
            }
        }
    }


    // ==========================================
    // 9. PLAYBACK CLOCK / MEDIA HELPERS
    // ==========================================

    function setPlaybackClock(
        startEpoch,
        offset
    ) {
        mediaOffset =
            Number(offset || 0);

        localSyncStartTime =
            Number(startEpoch || 0);


        const localNow =
            Date.now() / 1000;


        /*
         * If the server epoch looks invalid for the
         * current local clock, anchor it locally.
         */
        if (
            !localSyncStartTime
            || Math.abs(
                localNow
                - localSyncStartTime
            ) > 300
        ) {
            localSyncStartTime =
                localNow;
        }
    }


    function destroyHls() {
        if (!hls) {
            return;
        }


        try {
            hls.stopLoad();
        } catch (e) {}


        try {
            hls.detachMedia();
        } catch (e) {}


        try {
            hls.destroy();
        } catch (e) {}


        hls = null;
    }


    function safePauseVideo() {
        if (!video) {
            return;
        }


        isSystemAction = true;


        try {
            video.pause();
        } catch (e) {}


        setTimeout(
            () => {
                isSystemAction = false;
            },
            150
        );
    }


    function switchToPlexMode() {
        stopLocalBroadcast();


        if (remoteVideo) {
            try {
                remoteVideo.pause();
            } catch (e) {}


            remoteVideo.srcObject =
                null;

            remoteVideo.removeAttribute(
                'src'
            );
        }


        setUIState(
            'plex'
        );


        if (video) {
            video.style.display =
                'block';
        }
    }


    function resetVideoElement() {
        if (!video) {
            return;
        }


        try {
            video.pause();

            video.removeAttribute(
                'src'
            );

            video.load();

        } catch (e) {}
    }


    // ==========================================
    // 10. EMULATOR CLEANUP
    // ==========================================

    function cleanupEmulator() {
        stopLocalBroadcast();


        try {
            if (
                window.EJS_emulator
                && typeof window.EJS_emulator.pause
                    === 'function'
            ) {
                window.EJS_emulator.pause();
            }
        } catch (e) {}


        try {
            if (
                window.EJS_emulator
                && typeof window.EJS_emulator.stop
                    === 'function'
            ) {
                window.EJS_emulator.stop();
            }
        } catch (e) {}


        try {
            if (
                window.EJS_emulator
                && typeof window.EJS_emulator.destroy
                    === 'function'
            ) {
                window.EJS_emulator.destroy();
            }
        } catch (e) {}


        const wrapper =
            document.getElementById(
                'game-container'
            );


        if (wrapper) {
            wrapper.innerHTML = '';
        }


        if (
            emulatorLoaderScript
            && emulatorLoaderScript.parentNode
        ) {
            emulatorLoaderScript
                .parentNode
                .removeChild(
                    emulatorLoaderScript
                );
        }


        emulatorLoaderScript =
            null;


        if (emulatorBootInterval) {
            clearInterval(
                emulatorBootInterval
            );

            emulatorBootInterval =
                null;
        }


        try {
            delete window.EJS_player;
            delete window.EJS_core;
            delete window.EJS_color;
            delete window.EJS_pathtodata;
            delete window.EJS_gameUrl;
            delete window.EJS_emulator;
            delete window.EJS_Buttons;
            delete window.EJS_VirtualGamepadSettings;
        } catch (e) {}


        try {
            if (
                window.EJS_audio
                && typeof window.EJS_audio.close
                    === 'function'
            ) {
                window.EJS_audio.close();
            }
        } catch (e) {}


        try {
            delete window.EJS_audio;
        } catch (e) {}
    }


    // ==========================================
    // 11. NATIVE VIDEO EVENTS
    // ==========================================

    if (video) {

        video.addEventListener(
            'waiting',
            () => {
                if (
                    isHost
                    && !isBuffering
                    && socket
                    && !ignoreSyncWindow
                ) {
                    isBuffering = true;

                    socket.emit(
                        'user_buffering',
                        {
                            room_id: ROOM_ID,
                            current_time:
                                video.currentTime
                                || mediaOffset
                                || 0
                        }
                    );
                }
            }
        );


        video.addEventListener(
            'canplay',
            () => {
                if (
                    isHost
                    && isBuffering
                    && socket
                ) {
                    socket.emit(
                        'buffer_resolved',
                        {
                            room_id: ROOM_ID,
                            current_time:
                                video.currentTime
                                || mediaOffset
                                || 0
                        }
                    );
                }
            }
        );


        video.addEventListener(
            'ended',
            () => {
                updateCustomPlayerUI();

                if (!isHost) {
                    return;
                }


                reportPlexProgress(
                    'stopped',
                    true
                );


                prepareNextEpisode();
            }
        );


        video.addEventListener(
            'pause',
            () => {
                updateCustomPlayerUI();


                if (isSystemAction) {
                    return;
                }


                if (isHost) {
                    if (socket) {
                        socket.emit(
                            'user_pause',
                            {
                                room_id: ROOM_ID,
                                current_time:
                                    video.currentTime
                                    || 0
                            }
                        );
                    }


                    reportPlexProgress(
                        'paused'
                    );
                }
            }
        );


        video.addEventListener(
            'play',
            () => {
                updateCustomPlayerUI();
                showMediaControlsOverlay();


                if (isSystemAction) {
                    return;
                }


                if (isHost) {
                    if (socket) {
                        socket.emit(
                            'user_play',
                            {
                                room_id: ROOM_ID,
                                current_time:
                                    video.currentTime
                                    || 0
                            }
                        );
                    }


                    reportPlexProgress(
                        'playing'
                    );

                    return;
                }


                /*
                 * Viewers are only allowed to locally
                 * play while the room is itself playing.
                 */
                if (
                    !roomIsPlaying
                    || !currentMediaUrl
                ) {
                    safePauseVideo();
                    return;
                }


                /*
                 * Viewer intentionally resumes:
                 * send them back to the live room position.
                 */
                const expectedTime =
                    getExpectedRoomTime();


                if (
                    Number.isFinite(
                        expectedTime
                    )
                ) {
                    isSystemAction =
                        true;


                    try {
                        video.currentTime =
                            Math.max(
                                0,
                                expectedTime
                            );
                    } catch (e) {}


                    setTimeout(
                        () => {
                            isSystemAction =
                                false;
                        },
                        100
                    );
                }
            }
        );


        /*
         * Viewers no longer have a seekable timeline.
         * Therefore there is no viewer snap-back logic here.
         */
        video.addEventListener(
            'seeked',
            () => {
                updateCustomPlayerUI();


                if (isSystemAction) {
                    return;
                }


                if (isHost) {
                    reportPlexProgress(
                        video.paused
                            ? 'paused'
                            : 'playing'
                    );
                }
            }
        );


        [
            'timeupdate',
            'durationchange',
            'loadedmetadata'
        ].forEach(
            eventName => {
                video.addEventListener(
                    eventName,
                    updateCustomPlayerUI
                );
            }
        );
    }


    // ==========================================
    // 12. PERIODIC PLEX PROGRESS
    // ==========================================

    setInterval(
        () => {
            if (!isHost) {
                return;
            }

            if (!video) {
                return;
            }

            if (video.paused) {
                return;
            }

            if (video.ended) {
                return;
            }


            reportPlexProgress(
                'playing'
            );

        },
        PLEX_PROGRESS_INTERVAL_MS
    );


    window.addEventListener(
        'pagehide',
        () => {
            if (!isHost) {
                return;
            }

            if (!video) {
                return;
            }

            if (video.ended) {
                return;
            }


            reportPlexProgress(
                'stopped',
                false,
                true
            );
        }
    );


    // ==========================================
    // 13. CUSTOM PLAYER CONTROLS
    // ==========================================

    if (plexPlayToggle) {
        plexPlayToggle.addEventListener(
            'click',
            togglePlexPlayback
        );
    }


    if (
        video
        && plexPlayerShell
    ) {
        video.addEventListener(
            'click',
            togglePlexPlayback
        );
    }


    if (
        plexVolume
        && video
    ) {
        plexVolume.value =
            String(video.volume);


        plexVolume.addEventListener(
            'input',
            () => {
                const newVolume =
                    Math.min(
                        1,
                        Math.max(
                            0,
                            Number(
                                plexVolume.value
                            )
                        )
                    );


                video.volume =
                    newVolume;

                video.muted =
                    false;
            }
        );
    }


    if (
        plexMuteToggle
        && video
    ) {
        plexMuteToggle.addEventListener(
            'click',
            () => {
                video.muted =
                    !video.muted;
            }
        );
    }


    if (btnSyncToHost) {
        btnSyncToHost.addEventListener(
            'click',
            syncViewerToHost
        );
    }


    if (plexPlayerProgress) {

        plexPlayerProgress.addEventListener(
            'input',
            () => {
                if (!isHost) {
                    return;
                }


                isPlayerScrubbing =
                    true;


                if (plexPlayerTime) {
                    plexPlayerTime.textContent =
                        `${formatPlayerTime(
                            plexPlayerProgress.value
                        )} / `
                        + `${formatPlayerTime(
                            video
                                ? video.duration
                                : 0
                        )}`;
                }
            }
        );


        plexPlayerProgress.addEventListener(
            'change',
            () => {
                if (!isHost) {
                    return;
                }


                seekHostPlayer(
                    plexPlayerProgress.value
                );


                isPlayerScrubbing =
                    false;


                updateCustomPlayerUI();
            }
        );
    }


    if (plexFullscreenToggle) {
        plexFullscreenToggle.addEventListener(
            'click',
            async () => {
                try {
                    if (
                        !document.fullscreenElement
                    ) {
                        if (plexPlayerShell) {
                            await plexPlayerShell
                                .requestFullscreen();
                        }
                    } else {
                        await document
                            .exitFullscreen();
                    }

                } catch (err) {
                    console.warn(
                        'Fullscreen failed:',
                        err
                    );
                }
            }
        );
    }


    /*
     * YouTube-style double click fullscreen.
     *
     * The two click events will toggle playback twice,
     * leaving playback in the same state.
     */
    if (
        video
        && plexPlayerShell
    ) {
        video.addEventListener(
            'dblclick',
            async () => {
                try {
                    if (
                        !document.fullscreenElement
                    ) {
                        await plexPlayerShell
                            .requestFullscreen();
                    } else {
                        await document
                            .exitFullscreen();
                    }
                } catch (e) {}
            }
        );
    }


    if (plexPlayerShell) {

        plexPlayerShell.addEventListener(
            'mousemove',
            showMediaControlsOverlay
        );


        plexPlayerShell.addEventListener(
            'touchstart',
            showMediaControlsOverlay,
            {
                passive: true
            }
        );


        plexPlayerShell.addEventListener(
            'mouseleave',
            () => {
                const settingsOpen =
                    (
                        mediaSettingsPanel
                        && mediaSettingsPanel.style.display === 'flex'
                    );


                if (settingsOpen) {
                    return;
                }


                if (
                    video
                    && video.paused
                ) {
                    return;
                }


                clearTimeout(
                    controlsHideTimer
                );


                plexPlayerShell.classList.remove(
                    'controls-visible'
                );
            }
        );
    }


    // ==========================================
    // 14. NEXT EPISODE BUTTONS
    // ==========================================

    /*
     * Only ONE listener for each button.
     * The previous file had duplicate listener blocks.
     */

    if (btnNextEpisodePlay) {
        btnNextEpisodePlay.addEventListener(
            'click',
            () => {
                playNextEpisodeNow();
            }
        );
    }


    if (btnNextEpisodeCancel) {
        btnNextEpisodeCancel.addEventListener(
            'click',
            () => {
                clearNextEpisodeCountdown();
            }
        );
    }


    // ==========================================
    // 15. SETTINGS UI EVENTS
    // ==========================================

    if (mediaSettingsCog) {
        mediaSettingsCog.addEventListener(
            'click',
            e => {
                e.preventDefault();
                e.stopPropagation();


                if (
                    !isHost
                    || !mediaSettingsPanel
                ) {
                    return;
                }


                const isOpen =
                    mediaSettingsPanel.style.display
                    === 'flex';


                if (isOpen) {
                    hideMediaSettingsPanel();

                } else {

                    if (CURRENT_KEY) {
                        loadTrackOptions(
                            CURRENT_KEY
                        );
                    }


                    mediaSettingsPanel.style.display =
                        'flex';


                    mediaSettingsCog.classList.add(
                        'panel-open'
                    );


                    showMediaControlsOverlay();
                }
            }
        );
    }


    if (mediaSettingsPanel) {
        mediaSettingsPanel.addEventListener(
            'click',
            e => {
                e.stopPropagation();
            }
        );
    }


    if (btnApplyTracks) {
        btnApplyTracks.addEventListener(
            'click',
            applySelectedTracks
        );
    }


    // ==========================================
    // 16. SEARCH / GAME MODAL BUTTONS
    // ==========================================

    if (openSearchBtn) {
        openSearchBtn.addEventListener(
            'click',
            () => {
                if (searchModal) {
                    searchModal.classList.add(
                        'active'
                    );


                    if (searchInput) {
                        searchInput.focus();
                    }
                }
            }
        );
    }


    if (closeSearchBtn) {
        closeSearchBtn.addEventListener(
            'click',
            () => {
                if (searchModal) {
                    searchModal.classList.remove(
                        'active'
                    );
                }
            }
        );
    }


    if (btnOpenGames) {
        btnOpenGames.addEventListener(
            'click',
            () => {
                if (gameModal) {
                    gameModal.classList.add(
                        'active'
                    );
                }
            }
        );
    }


    if (closeGamesBtn) {
        closeGamesBtn.addEventListener(
            'click',
            () => {
                if (gameModal) {
                    gameModal.classList.remove(
                        'active'
                    );
                }
            }
        );
    }


    if (searchPlexBtn) {
        searchPlexBtn.addEventListener(
            'click',
            () => {
                if (!searchInput) {
                    return;
                }


                const query =
                    searchInput.value.trim();


                if (!query) {
                    return;
                }


                navigationStack = [];


                loadResults(
                    `/api/plex/search?q=${encodeURIComponent(query)}`
                );
            }
        );
    }


    if (searchInput) {
        searchInput.addEventListener(
            'keypress',
            e => {
                if (
                    e.key === 'Enter'
                    && searchPlexBtn
                ) {
                    searchPlexBtn.click();
                }
            }
        );
    }


    // ==========================================
    // 17. SOCKET.IO
    // ==========================================

    try {

        if (
            typeof io !== 'undefined'
        ) {

            socket = io();


            const connectionStatus =
                document.getElementById(
                    'connection-status'
                );


            function setConnectionStatus(
                text,
                state
            ) {
                if (!connectionStatus) {
                    return;
                }


                connectionStatus.textContent =
                    text;


                connectionStatus.dataset.state =
                    state;
            }


            socket.on(
                'connect',
                () => {
                    setConnectionStatus(
                        'Connected',
                        'connected'
                    );


                    socket.emit(
                        'join_watch_room',
                        {
                            room_id: ROOM_ID
                        }
                    );
                }
            );


            socket.on(
                'disconnect',
                () => {
                    setConnectionStatus(
                        'Connection lost',
                        'disconnected'
                    );
                }
            );


            socket.on(
                'connect_error',
                () => {
                    setConnectionStatus(
                        'Connection lost',
                        'disconnected'
                    );
                }
            );


            socket.io.on(
                'reconnect_attempt',
                () => {
                    setConnectionStatus(
                        'Reconnecting...',
                        'reconnecting'
                    );
                }
            );


            socket.io.on(
                'reconnect_error',
                () => {
                    setConnectionStatus(
                        'Connection lost',
                        'disconnected'
                    );
                }
            );


            // ==================================
            // CHAT
            // ==================================

            if (sendBtn) {
                sendBtn.addEventListener(
                    'click',
                    () => {
                        if (!chatInput) {
                            return;
                        }


                        const text =
                            chatInput.value.trim();


                        if (!text) {
                            return;
                        }


                        socket.emit(
                            'chat_message',
                            {
                                room_id: ROOM_ID,
                                text: text
                            }
                        );


                        chatInput.value = '';
                    }
                );
            }


            if (chatInput) {
                chatInput.addEventListener(
                    'keypress',
                    e => {
                        if (
                            e.key === 'Enter'
                            && sendBtn
                        ) {
                            sendBtn.click();
                        }
                    }
                );
            }


            socket.on(
                'chat_message',
                data => {
                    addMessage(
                        data.user,
                        data.text
                    );
                }
            );


            socket.on(
                'room_missing',
                data => {
                    alert(
                        data.message
                        || 'This room no longer exists.'
                    );


                    window.location.href =
                        '/plex-watch-together';
                }
            );


            // ==================================
            // ROOM STATE
            // ==================================

            socket.on(
                'room_state',
                data => {
                    if (
                        String(data.room_id)
                        !== String(ROOM_ID)
                    ) {
                        return;
                    }


                    if (!data.url) {
                        return;
                    }


                    switchToPlexMode();


                    const incomingKey =
                        String(
                            data.rating_key
                            || ''
                        );


                    const previousKey =
                        String(
                            CURRENT_KEY
                            || ''
                        );


                    /*
                     * Compare BEFORE replacing current values.
                     */
                    const sameMediaAlreadyLoaded =
                        (
                            currentMediaUrl
                                === data.url
                            && previousKey
                                === incomingKey
                            && video
                            && (
                                hls !== null
                                || (
                                    !!video.currentSrc
                                    && video.readyState > 0
                                )
                            )
                        );


                    roomIsPlaying =
                        data.is_playing
                        !== false;


                    isBuffering =
                        false;


                    if (mediaTitleElem) {
                        mediaTitleElem.innerText =
                            data.title
                            || 'Now Playing';
                    }


                    CURRENT_KEY =
                        incomingKey;


                    currentMediaUrl =
                        data.url;


                    appContainer.dataset.currentKey =
                        CURRENT_KEY;


                    if (
                        isHost
                        && CURRENT_KEY
                    ) {
                        loadTrackOptions(
                            CURRENT_KEY
                        );
                    }


                    updateMediaSettingsVisibility();


                    const currentTime =
                        Number(
                            data.current_time
                            || data.offset
                            || 0
                        );


                    setPlaybackClock(
                        Date.now() / 1000,
                        currentTime
                    );


                    if (
                        sameMediaAlreadyLoaded
                    ) {

                        /*
                         * Reconnect:
                         * do not rebuild HLS.
                         */
                        if (
                            !isHost
                            && video
                        ) {

                            if (!roomIsPlaying) {

                                if (
                                    Math.abs(
                                        video.currentTime
                                        - currentTime
                                    ) > 1
                                ) {
                                    isSystemAction =
                                        true;


                                    try {
                                        video.currentTime =
                                            Math.max(
                                                0,
                                                currentTime
                                            );
                                    } catch (e) {}


                                    setTimeout(
                                        () => {
                                            isSystemAction =
                                                false;
                                        },
                                        150
                                    );
                                }


                                if (!video.paused) {
                                    safePauseVideo();
                                }

                            } else if (
                                !video.paused
                            ) {

                                const drift =
                                    currentTime
                                    - video.currentTime;


                                if (
                                    Math.abs(drift)
                                    > 3
                                ) {
                                    isSystemAction =
                                        true;


                                    try {
                                        video.currentTime =
                                            Math.max(
                                                0,
                                                currentTime
                                            );
                                    } catch (e) {}


                                    setTimeout(
                                        () => {
                                            isSystemAction =
                                                false;
                                        },
                                        150
                                    );
                                }
                            }
                        }


                        updateCustomPlayerUI();
                        startSyncLoop();

                        return;
                    }


                    /*
                     * First room join, changed media,
                     * or destroyed/lost player.
                     */
                    loadVideo(
                        data.url,
                        currentTime,
                        roomIsPlaying
                    );


                    startSyncLoop();
                }
            );


            socket.on(
                'media_updated',
                data => {
                    if (
                        String(data.room_id)
                        !== String(ROOM_ID)
                    ) {
                        return;
                    }


                    if (!data.url) {
                        return;
                    }


                    clearNextEpisodeCountdown();

                    switchToPlexMode();


                    currentMediaUrl =
                        data.url;

                    roomIsPlaying =
                        true;

                    isBuffering =
                        false;


                    if (mediaTitleElem) {
                        mediaTitleElem.innerText =
                            data.title
                            || 'Now Playing';
                    }


                    CURRENT_KEY =
                        data.rating_key
                        || '';


                    appContainer.dataset.currentKey =
                        CURRENT_KEY;


                    if (
                        isHost
                        && CURRENT_KEY
                    ) {
                        loadTrackOptions(
                            CURRENT_KEY
                        );
                    }


                    updateMediaSettingsVisibility();


                    const startTime =
                        Number(
                            data.start_time
                            || data.offset
                            || 0
                        );


                    setPlaybackClock(
                        data.server_epoch
                        || (
                            Date.now() / 1000
                        ),
                        startTime
                    );


                    loadVideo(
                        data.url,
                        startTime,
                        true
                    );


                    startSyncLoop();
                }
            );


            // ==================================
            // ROOM USERS
            // ==================================

            const usersListElem =
                document.getElementById(
                    'users-list'
                );


            socket.on(
                'room_users_update',
                users => {
                    if (!usersListElem) {
                        return;
                    }


                    usersListElem.innerHTML =
                        '';


                    users.forEach(
                        user => {
                            const uDiv =
                                document.createElement(
                                    'div'
                                );


                            uDiv.style.padding =
                                '12px 15px';

                            uDiv.style.borderBottom =
                                '1px solid #222630';

                            uDiv.style.color =
                                '#ececec';

                            uDiv.style.display =
                                'flex';

                            uDiv.style.alignItems =
                                'center';

                            uDiv.style.gap =
                                '10px';


                            if (
                                isHost
                                && user
                                    !== HOST_USERNAME
                            ) {
                                uDiv.style.cursor =
                                    'pointer';
                            }


                            const hostBadge =
                                user === HOST_USERNAME
                                    ? '(Host) '
                                    : '';


                            uDiv.innerHTML = `
                                <div
                                    style="
                                        background:#e50914;
                                        color:white;
                                        width:28px;
                                        height:28px;
                                        border-radius:50%;
                                        display:flex;
                                        align-items:center;
                                        justify-content:center;
                                        font-weight:bold;
                                        font-size:0.85em;
                                    "
                                >
                                    ${user.charAt(0).toUpperCase()}
                                </div>

                                <span style="font-weight:500;">
                                    ${hostBadge}${user}
                                </span>
                            `;


                            uDiv.addEventListener(
                                'contextmenu',
                                e => {
                                    e.preventDefault();


                                    if (
                                        isHost
                                        && user
                                            !== HOST_USERNAME
                                    ) {

                                        if (
                                            confirm(
                                                `Crown ${user} as the new room host?`
                                            )
                                        ) {
                                            socket.emit(
                                                'transfer_host',
                                                {
                                                    room_id:
                                                        ROOM_ID,

                                                    new_host:
                                                        user
                                                }
                                            );
                                        }
                                    }
                                }
                            );


                            usersListElem.appendChild(
                                uDiv
                            );
                        }
                    );
                }
            );


            socket.on(
                'host_changed',
                data => {
                    HOST_USERNAME =
                        data.new_host;


                    const currentUsername =
                        appContainer.dataset.username;


                    isHost =
                        (
                            HOST_USERNAME
                            === currentUsername
                        );


                    addMessage(
                        'System',
                        `<span style="color:#e5a00d;">${HOST_USERNAME} is now the host</span>`
                    );


                    applyHostPermissions();


                    if (
                        isHost
                        && CURRENT_KEY
                    ) {
                        loadTrackOptions(
                            CURRENT_KEY,
                            true
                        );
                    }


                    updateMediaSettingsVisibility();


                    if (!isHost) {
                        clearNextEpisodeCountdown();
                        stopLocalBroadcast();
                    }


                    updateCustomPlayerUI();
                }
            );


            // ==================================
            // PLAYBACK FORCE EVENTS
            // ==================================

            socket.on(
                'force_pause',
                data => {
                    const offset =
                        Number(
                            data.offset
                            ?? (
                                video
                                    ? video.currentTime
                                    : 0
                            )
                            ?? mediaOffset
                            ?? 0
                        );


                    roomIsPlaying =
                        false;


                    mediaOffset =
                        offset;


                    localSyncStartTime =
                        Date.now() / 1000;


                    isBuffering =
                        false;


                    safePauseVideo();


                    if (
                        video
                        && Number.isFinite(offset)
                        && Math.abs(
                            video.currentTime
                            - offset
                        ) > 0.75
                    ) {
                        isSystemAction =
                            true;


                        video.currentTime =
                            offset;


                        setTimeout(
                            () => {
                                isSystemAction =
                                    false;
                            },
                            100
                        );
                    }


                    updateCustomPlayerUI();
                }
            );


            socket.on(
                'force_play',
                data => {
                    roomIsPlaying =
                        true;


                    setPlaybackClock(
                        data.server_epoch
                        || data.start_time,
                        data.offset
                        || 0
                    );


                    ignoreSyncWindow =
                        true;


                    setTimeout(
                        () => {
                            ignoreSyncWindow =
                                false;
                        },
                        3000
                    );


                    if (
                        video
                        && Math.abs(
                            video.currentTime
                            - mediaOffset
                        ) > 1
                    ) {
                        video.currentTime =
                            mediaOffset;
                    }


                    isBuffering =
                        false;

                    isSystemAction =
                        true;


                    if (video) {
                        video.play().catch(
                            e => {
                                console.log(
                                    'Autoplay blocked',
                                    e
                                );
                            }
                        );
                    }


                    setTimeout(
                        () => {
                            isSystemAction =
                                false;
                        },
                        100
                    );


                    updateCustomPlayerUI();
                }
            );


            /*
             * #10:
             * Explicit room seek event.
             */
            socket.on(
                'force_seek',
                data => {
                    if (!video) {
                        return;
                    }


                    const offset =
                        Number(
                            data.offset
                            || 0
                        );


                    if (
                        !Number.isFinite(
                            offset
                        )
                    ) {
                        return;
                    }


                    /*
                     * Preserve local viewer pause.
                     */
                    const wasLocallyPaused =
                        video.paused;


                    roomIsPlaying =
                        data.is_playing
                        !== false;


                    setPlaybackClock(
                        data.server_epoch
                        || (
                            Date.now() / 1000
                        ),
                        offset
                    );


                    isSystemAction =
                        true;


                    try {
                        video.currentTime =
                            Math.max(
                                0,
                                offset
                            );
                    } catch (e) {}


                    if (!roomIsPlaying) {

                        try {
                            video.pause();
                        } catch (e) {}

                    } else if (
                        !wasLocallyPaused
                    ) {

                        video.play().catch(
                            () => {}
                        );
                    }


                    setTimeout(
                        () => {
                            isSystemAction =
                                false;
                        },
                        150
                    );


                    updateCustomPlayerUI();
                }
            );


            // ==================================
            // WEBRTC SIGNALING
            // ==================================

            socket.on(
                'host_started_game',
                data => {
                    if (
                        String(data.room_id)
                        !== String(ROOM_ID)
                    ) {
                        return;
                    }


                    clearNextEpisodeCountdown();


                    if (!isHost) {

                        destroyHls();

                        safePauseVideo();

                        setUIState(
                            'emulator-viewer'
                        );


                        if (mediaTitleElem) {
                            mediaTitleElem.innerText =
                                `🎮 Playing: ${data.game_name}`;
                        }


                        socket.emit(
                            'viewer_joined',
                            ROOM_ID
                        );
                    }
                }
            );


            socket.on(
                'game_stopped',
                data => {
                    if (
                        String(data.room_id)
                        !== String(ROOM_ID)
                    ) {
                        return;
                    }


                    stopLocalBroadcast();


                    if (remoteVideo) {
                        try {
                            remoteVideo.pause();
                        } catch (e) {}


                        remoteVideo.srcObject =
                            null;


                        remoteVideo.removeAttribute(
                            'src'
                        );
                    }


                    setUIState(
                        'plex'
                    );


                    if (mediaTitleElem) {
                        mediaTitleElem.innerText =
                            currentMediaUrl
                                ? 'Game Stopped. Load media again.'
                                : 'Game Stopped. Select Media.';
                    }
                }
            );


            socket.on(
                'viewer_joined',
                async viewerId => {
                    if (
                        !isHost
                        || !localStream
                    ) {
                        return;
                    }


                    console.log(
                        `[WebRTC] Setting up connection for new viewer: ${viewerId}`
                    );


                    const pc =
                        createPeerConnection(
                            viewerId
                        );


                    localStream
                        .getTracks()
                        .forEach(
                            track => {
                                pc.addTrack(
                                    track,
                                    localStream
                                );
                            }
                        );


                    const offer =
                        await pc.createOffer();


                    await pc.setLocalDescription(
                        offer
                    );


                    socket.emit(
                        'webrtc_offer',
                        {
                            target:
                                viewerId,

                            caller:
                                socket.id,

                            sdp:
                                pc.localDescription,

                            room_id:
                                ROOM_ID
                        }
                    );
                }
            );


            socket.on(
                'webrtc_offer',
                async data => {
                    if (isHost) {
                        return;
                    }


                    console.log(
                        '[WebRTC] Received stream offer from host.'
                    );


                    const pc =
                        createPeerConnection(
                            data.caller
                        );


                    await pc.setRemoteDescription(
                        new RTCSessionDescription(
                            data.sdp
                        )
                    );


                    const answer =
                        await pc.createAnswer();


                    await pc.setLocalDescription(
                        answer
                    );


                    socket.emit(
                        'webrtc_answer',
                        {
                            target:
                                data.caller,

                            caller:
                                socket.id,

                            sdp:
                                pc.localDescription,

                            room_id:
                                ROOM_ID
                        }
                    );
                }
            );


            socket.on(
                'webrtc_answer',
                async data => {
                    if (!isHost) {
                        return;
                    }


                    const pc =
                        peerConnections[
                            data.caller
                        ];


                    if (pc) {
                        await pc.setRemoteDescription(
                            new RTCSessionDescription(
                                data.sdp
                            )
                        );
                    }
                }
            );


            socket.on(
                'webrtc_ice_candidate',
                async data => {
                    const pc =
                        peerConnections[
                            data.caller
                        ];


                    if (!pc) {
                        return;
                    }


                    try {
                        await pc.addIceCandidate(
                            new RTCIceCandidate(
                                data.candidate
                            )
                        );
                    } catch (e) {}
                }
            );
        }

    } catch (e) {
        console.error(
            '❌ Error initializing socket:',
            e
        );
    }


    // ==========================================
    // 18. PLEX PROGRESS REPORTING
    // ==========================================

    async function reportPlexProgress(
        state = null,
        completed = false,
        keepalive = false
    ) {
        if (!isHost) {
            return;
        }

        if (!video) {
            return;
        }

        if (!CURRENT_KEY) {
            return;
        }

        if (!currentMediaUrl) {
            return;
        }

        if (
            currentUIState !== 'plex'
        ) {
            return;
        }

        if (ignoreSyncWindow) {
            return;
        }


        const currentTime =
            Number(
                video.currentTime
                || 0
            );


        if (
            !Number.isFinite(
                currentTime
            )
            || currentTime <= 0
        ) {
            return;
        }


        const playbackState =
            state
            || (
                video.paused
                    ? 'paused'
                    : 'playing'
            );


        const payload = {
            rating_key:
                String(CURRENT_KEY),

            current_time:
                currentTime,

            state:
                playbackState,

            completed:
                completed
        };


        try {
            const response =
                await fetch(
                    `/api/room/${ROOM_ID}/plex-progress`,
                    {
                        method:
                            'POST',

                        headers: {
                            'Content-Type':
                                'application/json'
                        },

                        body:
                            JSON.stringify(
                                payload
                            ),

                        keepalive:
                            keepalive
                    }
                );


            if (
                response.status === 409
            ) {
                return;
            }


            if (!response.ok) {
                console.warn(
                    'Could not update Plex progress:',
                    response.status
                );
            }

        } catch (err) {

            if (!keepalive) {
                console.warn(
                    'Plex progress update failed:',
                    err
                );
            }
        }
    }


    // ==========================================
    // 19. NEXT EPISODE
    // ==========================================

    function clearNextEpisodeCountdown() {
        if (nextEpisodeCountdownTimer) {
            clearInterval(
                nextEpisodeCountdownTimer
            );

            nextEpisodeCountdownTimer =
                null;
        }


        nextEpisodeCandidate =
            null;

        nextEpisodeSourceKey =
            '';


        if (nextEpisodeOverlay) {
            nextEpisodeOverlay.style.display =
                'none';
        }


        if (nextEpisodeCountdown) {
            nextEpisodeCountdown.textContent =
                String(
                    NEXT_EPISODE_COUNTDOWN_SECONDS
                );
        }
    }


    async function playNextEpisodeNow() {
        if (!isHost) {
            return;
        }


        if (!nextEpisodeCandidate) {
            return;
        }


        const episode =
            nextEpisodeCandidate;


        clearNextEpisodeCountdown();


        /*
         * Next episode starts from 0,
         * regardless of Plex resume state.
         */
        await selectMedia(
            episode,
            0
        );
    }


    function startNextEpisodeCountdown(
        episode,
        sourceKey
    ) {
        if (!isHost) {
            return;
        }

        if (!episode) {
            return;
        }


        clearNextEpisodeCountdown();


        nextEpisodeCandidate =
            episode;

        nextEpisodeSourceKey =
            String(sourceKey);


        let secondsLeft =
            NEXT_EPISODE_COUNTDOWN_SECONDS;


        const showTitle =
            episode.show_title
            || 'Unknown Show';


        const seasonNumber =
            Number(
                episode.season_number
                || 0
            );


        const episodeNumber =
            Number(
                episode.episode_number
                || 0
            );


        if (nextEpisodeTitle) {
            nextEpisodeTitle.textContent =
                `${showTitle} — `
                + `S${seasonNumber}:E${episodeNumber} - `
                + `${episode.title || 'Next Episode'}`;
        }


        if (nextEpisodeCountdown) {
            nextEpisodeCountdown.textContent =
                String(secondsLeft);
        }


        if (nextEpisodeOverlay) {
            nextEpisodeOverlay.style.display =
                'flex';
        }


        nextEpisodeCountdownTimer =
            setInterval(
                () => {
                    /*
                     * Abort if:
                     * - host changed
                     * - game mode started
                     * - media changed
                     */
                    if (
                        !isHost
                        || currentUIState
                            !== 'plex'
                        || String(CURRENT_KEY)
                            !== nextEpisodeSourceKey
                    ) {
                        clearNextEpisodeCountdown();
                        return;
                    }


                    secondsLeft -= 1;


                    if (nextEpisodeCountdown) {
                        nextEpisodeCountdown.textContent =
                            String(
                                Math.max(
                                    0,
                                    secondsLeft
                                )
                            );
                    }


                    if (secondsLeft <= 0) {
                        playNextEpisodeNow();
                    }

                },
                1000
            );
    }


    async function prepareNextEpisode() {
        if (!isHost) {
            return;
        }

        if (!CURRENT_KEY) {
            return;
        }

        if (
            currentUIState !== 'plex'
        ) {
            return;
        }


        const endedKey =
            String(CURRENT_KEY);


        clearNextEpisodeCountdown();


        try {
            const response =
                await fetch(
                    `/api/room/${ROOM_ID}/next-episode/`
                    + encodeURIComponent(
                        endedKey
                    )
                );


            if (
                response.status === 409
            ) {
                return;
            }


            const data =
                await response.json();


            if (!response.ok) {
                throw new Error(
                    data.error
                    || 'Could not find next episode'
                );
            }


            /*
             * Request completed after media changed.
             */
            if (
                !isHost
                || String(CURRENT_KEY)
                    !== endedKey
            ) {
                return;
            }


            if (!data.next_episode) {
                return;
            }


            startNextEpisodeCountdown(
                data.next_episode,
                endedKey
            );

        } catch (err) {
            console.warn(
                'Could not prepare next episode:',
                err
            );
        }
    }


    // ==========================================
    // 20. ROOM SYNC LOOP
    // ==========================================

    function startSyncLoop() {
        if (syncInterval) {
            clearInterval(
                syncInterval
            );
        }


        syncInterval =
            setInterval(
                () => {
                    if (
                        !video
                        || video.paused
                        || isBuffering
                        || ignoreSyncWindow
                    ) {
                        return;
                    }


                    const expectedTime =
                        (
                            (Date.now() / 1000)
                            - localSyncStartTime
                        )
                        + mediaOffset;


                    const actualTime =
                        video.currentTime;


                    const drift =
                        expectedTime
                        - actualTime;


                    if (!isHost) {

                        if (
                            Math.abs(drift)
                            > 3
                        ) {
                            isSystemAction =
                                true;


                            video.currentTime =
                                expectedTime;


                            setTimeout(
                                () => {
                                    isSystemAction =
                                        false;
                                },
                                100
                            );

                        } else if (
                            drift > 0.5
                        ) {

                            if (
                                video.playbackRate
                                !== 1.15
                            ) {
                                video.playbackRate =
                                    1.15;
                            }

                        } else if (
                            drift < -0.5
                        ) {

                            if (
                                video.playbackRate
                                !== 0.9
                            ) {
                                video.playbackRate =
                                    0.9;
                            }

                        } else {

                            if (
                                video.playbackRate
                                !== 1
                            ) {
                                video.playbackRate =
                                    1;
                            }
                        }

                    } else {

                        /*
                         * Existing host sync behavior preserved.
                         *
                         * We have not changed this here because
                         * this file rebuild is specifically the
                         * custom-player/#10 work.
                         */
                        if (
                            drift > 3
                        ) {
                            isBuffering =
                                true;


                            safePauseVideo();


                            if (socket) {
                                socket.emit(
                                    'user_buffering',
                                    {
                                        room_id:
                                            ROOM_ID,

                                        current_time:
                                            video.currentTime
                                            || mediaOffset
                                            || 0
                                    }
                                );
                            }


                            if (
                                video.readyState >= 3
                            ) {
                                setTimeout(
                                    () => {
                                        if (socket) {
                                            socket.emit(
                                                'buffer_resolved',
                                                {
                                                    room_id:
                                                        ROOM_ID,

                                                    current_time:
                                                        video.currentTime
                                                        || mediaOffset
                                                        || 0
                                                }
                                            );
                                        }
                                    },
                                    500
                                );
                            }

                        } else if (
                            drift > 0.5
                        ) {

                            if (
                                video.playbackRate
                                !== 1.15
                            ) {
                                video.playbackRate =
                                    1.15;
                            }

                        } else if (
                            drift < -0.5
                        ) {

                            if (
                                video.playbackRate
                                !== 0.9
                            ) {
                                video.playbackRate =
                                    0.9;
                            }

                        } else {

                            if (
                                video.playbackRate
                                !== 1
                            ) {
                                video.playbackRate =
                                    1;
                            }
                        }
                    }

                },
                2000
            );
    }


    // ==========================================
    // 21. CHAT DISPLAY
    // ==========================================

    function addMessage(
        user,
        text
    ) {
        if (!chatBox) {
            return;
        }


        const msgDiv =
            document.createElement(
                'div'
            );


        msgDiv.className =
            'chat-msg';


        /*
         * Existing rendering behavior preserved.
         * Safe text rendering is still planned for #21.
         */
        if (
            user === HOST_USERNAME
        ) {
            msgDiv.innerHTML =
                `<strong style="color:#e5a00d;">${user} (Host)</strong> `
                + `<span style="color:#ececec;">${text}</span>`;

        } else {

            msgDiv.innerHTML =
                `<strong>${user}</strong> `
                + `<span style="color:#ccc;">${text}</span>`;
        }


        chatBox.appendChild(
            msgDiv
        );


        chatBox.scrollTop =
            chatBox.scrollHeight;
    }


    // ==========================================
    // 22. PLEX SEARCH RESULTS
    // ==========================================

    async function loadResults(
        url,
        isDrillDown = false
    ) {
        if (!resultsContainer) {
            return;
        }


        resultsContainer.innerHTML =
            '<p style="color:#ccc; text-align:center; margin-top:50px;">Loading...</p>';


        try {
            const response =
                await fetch(url);


            const items =
                await response.json();


            resultsContainer.innerHTML =
                '';


            if (
                !Array.isArray(items)
            ) {
                throw new Error(
                    items.error
                    || 'Invalid Plex response'
                );
            }


            if (items.length === 0) {
                resultsContainer.innerHTML =
                    '<p style="color:#ccc; text-align:center;">No results found.</p>';

                return;
            }


            const firstItem =
                items[0];


            const isEpisodeMode =
                (
                    firstItem
                    && firstItem.type
                        === 'Episode'
                );


            const cardClass =
                isEpisodeMode
                    ? 'episode-style'
                    : 'poster-style';


            if (
                isDrillDown
                && navigationStack.length > 0
            ) {
                const backBtn =
                    document.createElement(
                        'div'
                    );


                backBtn.className =
                    `movie-card back-card ${cardClass}`;


                backBtn.innerHTML =
                    '<div class="back-icon">⬅</div>'
                    + '<div class="back-text">BACK</div>';


                backBtn.addEventListener(
                    'click',
                    () => {
                        navigationStack.pop();


                        const previous =
                            navigationStack[
                                navigationStack.length
                                - 1
                            ];


                        if (previous) {
                            loadResults(
                                previous.url,
                                navigationStack.length
                                    > 0
                            );

                        } else if (
                            searchInput
                            && searchInput.value
                            && searchPlexBtn
                        ) {
                            searchPlexBtn.click();
                        }
                    }
                );


                resultsContainer.appendChild(
                    backBtn
                );
            }


            items.forEach(
                item => {
                    const card =
                        document.createElement(
                            'div'
                        );


                    card.className =
                        `movie-card ${cardClass}`;


                    const imageUrl =
                        item.thumb
                            ? `/api/plex/image?path=${encodeURIComponent(item.thumb)}`
                            : 'https://via.placeholder.com/300x450';


                    let subTitle =
                        item.year || '';


                    if (
                        item.type === 'Episode'
                        || item.type === 'Season'
                    ) {
                        subTitle =
                            item.type;
                    }


                    const isPlayable =
                        (
                            item.type === 'Movie'
                            || item.type
                                === 'Episode'
                        );


                    const progressPercent =
                        Math.min(
                            100,
                            Math.max(
                                0,
                                Number(
                                    item.progress_percent
                                    || 0
                                )
                            )
                        );


                    let watchStateHtml =
                        '';

                    let actionsHtml =
                        '';


                    if (
                        isPlayable
                        && item.watched
                    ) {
                        watchStateHtml = `
                            <div class="media-watch-state watched">
                                ✓ Watched
                            </div>
                        `;

                    } else if (
                        isPlayable
                        && item.is_resume
                    ) {

                        watchStateHtml = `
                            <div class="media-progress-track">
                                <div
                                    class="media-progress-fill"
                                    style="width:${progressPercent}%;"
                                ></div>
                            </div>

                            <div class="media-watch-state">
                                ${Math.round(progressPercent)}% watched
                            </div>
                        `;


                        actionsHtml = `
                            <div class="movie-card-actions">
                                <button
                                    type="button"
                                    class="movie-card-action resume-media"
                                >
                                    Resume
                                </button>

                                <button
                                    type="button"
                                    class="movie-card-action start-over-media"
                                >
                                    Start Over
                                </button>
                            </div>
                        `;
                    }


                    card.innerHTML = `
                        <div class="movie-card-image">
                            <img
                                src="${imageUrl}"
                                loading="lazy"
                            >
                        </div>

                        <div class="movie-info">
                            <div class="movie-title">
                                ${item.title}
                            </div>

                            <div class="movie-meta">
                                ${subTitle}
                            </div>

                            ${watchStateHtml}
                            ${actionsHtml}
                        </div>
                    `;


                    const resumeBtn =
                        card.querySelector(
                            '.resume-media'
                        );


                    const startOverBtn =
                        card.querySelector(
                            '.start-over-media'
                        );


                    if (resumeBtn) {
                        resumeBtn.addEventListener(
                            'click',
                            e => {
                                e.preventDefault();
                                e.stopPropagation();


                                const resumeSeconds =
                                    Number(
                                        item.view_offset_ms
                                        || 0
                                    )
                                    / 1000;


                                selectMedia(
                                    item,
                                    resumeSeconds
                                );
                            }
                        );
                    }


                    if (startOverBtn) {
                        startOverBtn.addEventListener(
                            'click',
                            e => {
                                e.preventDefault();
                                e.stopPropagation();


                                selectMedia(
                                    item,
                                    0
                                );
                            }
                        );
                    }


                    card.addEventListener(
                        'click',
                        () => {
                            handleItemClick(
                                item
                            );
                        }
                    );


                    resultsContainer.appendChild(
                        card
                    );
                }
            );

        } catch (err) {
            console.error(
                'Plex search/load error:',
                err
            );


            resultsContainer.innerHTML =
                '<p style="color:red; text-align:center;">Error loading data.</p>';
        }
    }


    function handleItemClick(item) {
        if (
            item.type === 'Show'
            || item.type === 'Season'
        ) {
            navigationStack.push(
                {
                    url:
                        `/api/plex/children?key=${item.key}`
                }
            );


            loadResults(
                `/api/plex/children?key=${item.key}`,
                true
            );


            return;
        }


        if (
            item.type === 'Movie'
            || item.type === 'Episode'
        ) {
            const startTime =
                item.is_resume
                    ? (
                        Number(
                            item.view_offset_ms
                            || 0
                        )
                        / 1000
                    )
                    : 0;


            selectMedia(
                item,
                startTime
            );
        }
    }


    // ==========================================
    // 23. SELECT / CHANGE PLEX MEDIA
    // ==========================================

    async function selectMedia(
        media,
        requestedStartTime = null
    ) {
        if (!isHost) {
            return;
        }


        clearNextEpisodeCountdown();


        const rawKey =
            String(media.key)
                .split('/')
                .pop();


        const maxVideoBitrate =
            videoQualitySelect
                ? videoQualitySelect.value
                : (
                    localStorage.getItem(
                        'watchPartyVideoBitrate'
                    )
                    || '8000'
                );


        const payload = {
            rating_key:
                rawKey,

            max_video_bitrate:
                maxVideoBitrate
        };


        trackOptionsLoadedForKey =
            '';


        /*
         * Explicit 0 means Start Over,
         * so we test against null rather than truthiness.
         */
        if (
            requestedStartTime
            !== null
        ) {
            payload.view_offset =
                Math.max(
                    0,
                    Number(
                        requestedStartTime
                    )
                    || 0
                );

        } else if (
            rawKey === String(CURRENT_KEY)
            && video
            && !video.paused
            && video.currentTime > 0
        ) {
            payload.view_offset =
                video.currentTime;
        }


        try {
            const response =
                await fetch(
                    `/api/room/${ROOM_ID}/set_media`,
                    {
                        method:
                            'POST',

                        headers: {
                            'Content-Type':
                                'application/json'
                        },

                        body:
                            JSON.stringify(
                                payload
                            )
                    }
                );


            const data =
                await response.json();


            if (
                response.ok
                && data.success
            ) {
                if (searchModal) {
                    searchModal.classList.remove(
                        'active'
                    );
                }

            } else {

                alert(
                    'Server Error: '
                    + (
                        data.error
                        || 'Unknown error'
                    )
                );
            }

        } catch (err) {
            console.error(
                'Error setting media:',
                err
            );


            alert(
                'Error setting media'
            );
        }
    }


    // ==========================================
    // 24. HLS VIDEO LOADING
    // ==========================================

    function loadVideo(
        url,
        startTime = 0,
        shouldPlay = true
    ) {
        if (
            !url
            || !video
        ) {
            return;
        }


        currentMediaUrl =
            url;


        setUIState(
            'plex'
        );


        updateMediaSettingsVisibility();


        ignoreSyncWindow =
            true;


        setTimeout(
            () => {
                ignoreSyncWindow =
                    false;
            },
            4000
        );


        const targetStart =
            Number(
                startTime
                || 0
            );


        destroyHls();

        resetVideoElement();


        video.volume =
            Math.min(
                1,
                Math.max(
                    0,
                    localVolume
                )
            );


        video.muted =
            localMuted;


        updateCustomPlayerUI();


        if (Hls.isSupported()) {

            hls =
                new Hls(
                    {
                        debug:
                            false,

                        enableWorker:
                            true,

                        /*
                         * Plex movies/episodes are VOD.
                         */
                        lowLatencyMode:
                            false,

                        startPosition:
                            targetStart > 0
                                ? targetStart
                                : -1,

                        abrEwmaDefaultEstimate:
                            1000000,

                        abrBandWidthFactor:
                            0.7,

                        abrBandWidthUpFactor:
                            0.5,

                        capLevelToPlayerSize:
                            true,

                        startLevel:
                            -1
                    }
                );


            hls.loadSource(
                url
            );


            hls.attachMedia(
                video
            );


            hls.on(
                Hls.Events.MANIFEST_PARSED,
                () => {

                    if (
                        targetStart > 0
                    ) {
                        try {
                            video.currentTime =
                                targetStart;
                        } catch (e) {}
                    }


                    isSystemAction =
                        true;


                    if (shouldPlay) {

                        video.play().catch(
                            err => {
                                console.warn(
                                    'Plex autoplay blocked:',
                                    err
                                );
                            }
                        );

                    } else {

                        video.pause();
                    }


                    setTimeout(
                        () => {
                            isSystemAction =
                                false;
                        },
                        200
                    );


                    updateCustomPlayerUI();
                }
            );


            hls.on(
                Hls.Events.ERROR,
                (
                    event,
                    data
                ) => {
                    console.warn(
                        'HLS error:',
                        data
                    );


                    if (!data.fatal) {
                        return;
                    }


                    switch (data.type) {

                        case Hls.ErrorTypes.NETWORK_ERROR:

                            console.warn(
                                'Fatal HLS network error. Restarting load.'
                            );

                            hls.startLoad();

                            break;


                        case Hls.ErrorTypes.MEDIA_ERROR:

                            console.warn(
                                'Fatal HLS media error. Recovering.'
                            );

                            hls.recoverMediaError();

                            break;


                        default:

                            console.error(
                                'Fatal unrecoverable HLS error.'
                            );

                            destroyHls();

                            break;
                    }
                }
            );

        } else if (
            video.canPlayType(
                'application/vnd.apple.mpegurl'
            )
        ) {

            video.src =
                url;


            video.addEventListener(
                'loadedmetadata',
                () => {

                    if (
                        targetStart > 0
                    ) {
                        try {
                            video.currentTime =
                                targetStart;
                        } catch (e) {}
                    }


                    isSystemAction =
                        true;


                    if (shouldPlay) {

                        video.play().catch(
                            err => {
                                console.warn(
                                    'Native HLS autoplay blocked:',
                                    err
                                );
                            }
                        );

                    } else {

                        video.pause();
                    }


                    setTimeout(
                        () => {
                            isSystemAction =
                                false;
                        },
                        200
                    );


                    updateCustomPlayerUI();

                },
                {
                    once: true
                }
            );
        }
    }


    // ==========================================
    // 25. GAME BOOTING
    // ==========================================

    window.fetchGames =
        async function(system) {
            if (!gameResults) {
                return;
            }


            gameResults.innerHTML =
                '<p style="color:#ccc; text-align:center;">Loading games...</p>';


            try {
                const res =
                    await fetch(
                        `/api/roms/${system}`
                    );


                const games =
                    await res.json();


                gameResults.innerHTML =
                    '';


                if (
                    games.length === 0
                ) {
                    gameResults.innerHTML =
                        '<p style="color:#ccc; text-align:center;">No games found.</p>';

                    return;
                }


                games.forEach(
                    game => {
                        const btn =
                            document.createElement(
                                'button'
                            );


                        btn.className =
                            'btn-choose-media';


                        btn.style.cssText =
                            'display:block;'
                            + 'width:100%;'
                            + 'text-align:left;'
                            + 'padding:15px;'
                            + 'margin-bottom:5px;'
                            + 'background:#222;';


                        btn.innerText =
                            game.name;


                        btn.onclick =
                            () => {
                                bootGame(
                                    game.core,
                                    game.path,
                                    game.name
                                );
                            };


                        gameResults.appendChild(
                            btn
                        );
                    }
                );

            } catch (err) {
                console.error(
                    'Error loading games:',
                    err
                );


                gameResults.innerHTML =
                    '<p style="color:red; text-align:center;">Error loading games.</p>';
            }
        };


    function bootGame(
        core,
        romPath,
        gameName
    ) {
        if (!isHost) {
            return;
        }


        clearNextEpisodeCountdown();

        cleanupEmulator();


        if (gameModal) {
            gameModal.classList.remove(
                'active'
            );
        }


        destroyHls();

        safePauseVideo();


        setUIState(
            'emulator-host'
        );


        if (mediaTitleElem) {
            mediaTitleElem.innerText =
                `🎮 Playing: ${gameName}`;
        }


        const wrapper =
            document.getElementById(
                'game-container'
            );


        if (!wrapper) {
            return;
        }


        wrapper.innerHTML =
            '<div id="game" style="width:100%; height:100%;"></div>';


        window.EJS_player =
            '#game';

        window.EJS_core =
            core;

        window.EJS_color =
            '#007BFF';

        window.EJS_pathtodata =
            'https://cdn.emulatorjs.org/stable/data/';

        window.EJS_gameUrl =
            '/static/'
            + romPath;


        emulatorLoaderScript =
            document.createElement(
                'script'
            );


        emulatorLoaderScript.src =
            'https://cdn.emulatorjs.org/stable/data/loader.js';


        document.body.appendChild(
            emulatorLoaderScript
        );


        emulatorBootInterval =
            setInterval(
                () => {
                    const canvas =
                        document.querySelector(
                            '#game canvas'
                        );


                    if (!canvas) {
                        return;
                    }


                    clearInterval(
                        emulatorBootInterval
                    );


                    emulatorBootInterval =
                        null;


                    if (btnStartBroadcast) {
                        btnStartBroadcast.style.display =
                            'inline-block';
                    }

                },
                1000
            );
    }


    if (btnStopGame) {
        btnStopGame.addEventListener(
            'click',
            () => {
                if (!isHost) {
                    return;
                }


                cleanupEmulator();


                setUIState(
                    'plex'
                );


                if (mediaTitleElem) {
                    mediaTitleElem.innerText =
                        currentMediaUrl
                            ? 'Game Stopped. Load media again.'
                            : 'Game Stopped. Select Media.';
                }


                addMessage(
                    'System',
                    'Host stopped the game.'
                );


                if (socket) {
                    socket.emit(
                        'host_stopped_game',
                        {
                            room_id:
                                ROOM_ID
                        }
                    );
                }
            }
        );
    }


    if (btnStartBroadcast) {
        btnStartBroadcast.addEventListener(
            'click',
            () => {
                if (!isHost) {
                    return;
                }


                const canvas =
                    document.querySelector(
                        '#game canvas'
                    );


                if (!canvas) {
                    return;
                }


                const gameName =
                    mediaTitleElem
                        ? mediaTitleElem.innerText.replace(
                            '🎮 Playing: ',
                            ''
                        )
                        : 'A Game';


                startWebRTCBroadcast(
                    canvas,
                    gameName
                );
            }
        );
    }


    // ==========================================
    // 26. WEBRTC CORE
    // ==========================================

    async function startWebRTCBroadcast(
        canvas,
        gameName
    ) {
        if (!isHost) {
            return;
        }


        try {
            console.log(
                '[WebRTC] Starting game broadcast...'
            );


            const videoStream =
                canvas.captureStream(
                    30
                );


            const tracks = [
                ...videoStream
                    .getVideoTracks()
            ];


            console.log(
                '[WebRTC] Captured video tracks:',
                tracks
            );


            /*
             * Audio is optional.
             *
             * Existing behavior preserved:
             * this captures microphone audio.
             */
            try {
                const audioStream =
                    await navigator.mediaDevices.getUserMedia(
                        {
                            audio: {
                                echoCancellation:
                                    false,

                                noiseSuppression:
                                    false,

                                autoGainControl:
                                    false
                            },

                            video:
                                false
                        }
                    );


                tracks.push(
                    ...audioStream
                        .getAudioTracks()
                );


                console.log(
                    '[WebRTC] Mic audio captured.'
                );

            } catch (audioErr) {
                console.warn(
                    '[WebRTC] Mic audio unavailable. Continuing video-only.',
                    audioErr
                );


                addMessage(
                    'System',
                    '<span style="color:#e5a00d;">Mic audio unavailable. Broadcasting video only.</span>'
                );
            }


            localStream =
                new MediaStream(
                    tracks
                );


            if (
                localStream
                    .getVideoTracks()
                    .length === 0
            ) {
                throw new Error(
                    'No video track was captured from the emulator canvas.'
                );
            }


            if (!socket) {
                throw new Error(
                    'Socket connection unavailable.'
                );
            }


            socket.emit(
                'host_started_game',
                {
                    room_id:
                        ROOM_ID,

                    game_name:
                        gameName
                }
            );


            addMessage(
                'System',
                '<span style="color:#007BFF;">Game Broadcast Live! Viewers are tuning in.</span>'
            );


            if (btnStartBroadcast) {
                btnStartBroadcast.style.display =
                    'none';
            }

        } catch (err) {
            console.error(
                '[WebRTC] Broadcast Error:',
                err
            );


            alert(
                'Could not start game broadcast. Check the browser console for the WebRTC error.'
            );
        }
    }


    function createPeerConnection(
        peerId
    ) {
        console.log(
            '[WebRTC] Creating peer connection for:',
            peerId
        );


        const pc =
            new RTCPeerConnection(
                ICE_SERVERS
            );


        peerConnections[
            peerId
        ] = pc;


        pc.onicecandidate =
            e => {
                if (
                    !e.candidate
                    || !socket
                ) {
                    return;
                }


                console.log(
                    '[WebRTC] Sending ICE candidate to:',
                    peerId
                );


                socket.emit(
                    'webrtc_ice_candidate',
                    {
                        target:
                            peerId,

                        caller:
                            socket.id,

                        candidate:
                            e.candidate,

                        room_id:
                            ROOM_ID
                    }
                );
            };


        pc.ontrack =
            e => {
                console.log(
                    '[WebRTC] Remote track received:',
                    e.track.kind,
                    e.streams
                );


                if (
                    isHost
                    || !remoteVideo
                ) {
                    return;
                }


                remoteVideo.srcObject =
                    e.streams[0];


                remoteVideo.autoplay =
                    true;

                remoteVideo.playsInline =
                    true;

                remoteVideo.controls =
                    true;

                remoteVideo.style.pointerEvents =
                    'auto';


                remoteVideo.volume =
                    Math.min(
                        1,
                        Math.max(
                            0,
                            localGameVolume
                        )
                    );


                remoteVideo.muted =
                    localGameMuted;


                setUIState(
                    'emulator-viewer'
                );


                remoteVideo.play()
                    .then(
                        () => {
                            console.log(
                                '[WebRTC] Remote game stream playing.'
                            );
                        }
                    )
                    .catch(
                        err => {
                            console.warn(
                                '[WebRTC] Remote game stream autoplay blocked:',
                                err
                            );


                            addMessage(
                                'System',
                                '<span style="color:#e5a00d;">Click the game stream to start playback.</span>'
                            );
                        }
                    );
            };


        pc.oniceconnectionstatechange =
            () => {
                console.log(
                    '[WebRTC] ICE state for',
                    peerId,
                    '=',
                    pc.iceConnectionState
                );


                if (
                    pc.iceConnectionState
                        === 'connected'
                    || pc.iceConnectionState
                        === 'completed'
                ) {
                    console.log(
                        '[WebRTC] Peer connected:',
                        peerId
                    );
                }


                if (
                    pc.iceConnectionState
                        === 'disconnected'
                    || pc.iceConnectionState
                        === 'failed'
                ) {
                    console.warn(
                        '[WebRTC] Peer disconnected/failed:',
                        peerId
                    );


                    pc.close();


                    delete peerConnections[
                        peerId
                    ];
                }
            };


        pc.onconnectionstatechange =
            () => {
                console.log(
                    '[WebRTC] Connection state for',
                    peerId,
                    '=',
                    pc.connectionState
                );
            };


        return pc;
    }


    function stopLocalBroadcast() {
        if (localStream) {
            localStream
                .getTracks()
                .forEach(
                    track => {
                        track.stop();
                    }
                );


            localStream =
                null;
        }


        Object
            .values(
                peerConnections
            )
            .forEach(
                pc => {
                    try {
                        pc.close();
                    } catch (e) {}
                }
            );


        peerConnections = {};
    }


    // ==========================================
    // 27. INITIALIZE
    // ==========================================

    applyHostPermissions();

    updateCustomPlayerUI();

    updateMediaSettingsVisibility();

    /*
     * Initial playback intentionally waits for
     * the Socket.IO room_state event.
     *
     * This preserves #2 and avoids double-loading HLS.
     */
});