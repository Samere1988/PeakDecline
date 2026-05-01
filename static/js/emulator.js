document.addEventListener('DOMContentLoaded', () => {

    // --- The Search Logic ---
    const searchBox = document.getElementById('rom-search');

    searchBox.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();

        // If search is empty, go back to the root folder view
        if (query.trim() === '') {
            window.showFolders();
            return;
        }

        // Hide the root folders and change the title
        document.getElementById('view-folders').style.display = 'none';
        document.getElementById('back-btn').style.display = 'block';
        document.getElementById('explorer-title').innerText = 'Search Results';

        // Check every single file across all consoles
        document.querySelectorAll('.file-view').forEach(view => {
            let hasVisibleMatch = false;

            view.querySelectorAll('.file-btn').forEach(btn => {
                if (btn.innerText.toLowerCase().includes(query)) {
                    btn.style.display = 'block';
                    hasVisibleMatch = true;
                } else {
                    btn.style.display = 'none';
                }
            });

            // Only show the console's container if it has matching games
            if (hasVisibleMatch) {
                view.style.display = 'flex';
            } else {
                view.style.display = 'none';
            }
        });
    });
});

// Navigates INTO a specific console folder
window.openFolder = function(consoleName) {
    // Reset search box and ensure all buttons are visible
    document.getElementById('rom-search').value = '';
    document.querySelectorAll('.file-btn').forEach(btn => btn.style.display = 'block');

    document.getElementById('view-folders').style.display = 'none';
    document.querySelectorAll('.file-view').forEach(el => el.style.display = 'none');

    document.getElementById('view-' + consoleName).style.display = 'flex';

    const titles = {'snes': 'Super Nintendo', 'n64': 'Nintendo 64', 'psx': 'PlayStation 1'};
    document.getElementById('explorer-title').innerText = titles[consoleName];
    document.getElementById('back-btn').style.display = 'block';
};

// Navigates BACK to the main root folder
window.showFolders = function() {
    // Reset search box and ensure all buttons are visible
    document.getElementById('rom-search').value = '';
    document.querySelectorAll('.file-btn').forEach(btn => btn.style.display = 'block');

    document.querySelectorAll('.file-view').forEach(el => el.style.display = 'none');
    document.getElementById('view-folders').style.display = 'flex';

    document.getElementById('explorer-title').innerText = 'Game Library';
    document.getElementById('back-btn').style.display = 'none';
};

// ... keep your window.loadGame function below here exactly as it was! ...
// The function that dynamically boots the console
window.loadGame = function(core, romPath) {
    // Hide the standby text
    document.getElementById('placeholder-text').style.display = 'none';

    // Completely reset the game container to prevent double-loading
    const wrapper = document.getElementById('game-wrapper');
    const existingGame = document.getElementById('game');
    if (existingGame) wrapper.removeChild(existingGame);

    const newGameDiv = document.createElement('div');
    newGameDiv.id = 'game';
    wrapper.appendChild(newGameDiv);

    // Tell EmulatorJS what to boot
    window.EJS_player = '#game';
    window.EJS_core = core;       // 'snes', 'n64', or 'psx'
    window.EJS_color = '#007BFF'; // Updated to PeakDecline Blue to match your new logo
    window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';

    // Construct the full URL to your static folder
    window.EJS_gameUrl = '/static/' + romPath;

    // Inject the EmulatorJS engine script into the page
    const script = document.createElement('script');
    script.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
    document.body.appendChild(script);

    // Highlight the TV screen border to show it's active
    wrapper.style.borderColor = '#007BFF'; // PeakDecline Blue
    wrapper.style.boxShadow = '0 15px 40px rgba(0, 123, 255, 0.2)';
};