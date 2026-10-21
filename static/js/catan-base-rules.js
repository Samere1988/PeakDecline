/* Base and extended-map rule reference, summarized from Colonist's published rules. */
(() => {
    'use strict';
    const root = document.querySelector('.catan-app');
    if (!root) return;
    const baseSource = 'https://colonist.io/catan-rules';
    const extendedSource = 'https://colonist.io/catan-rules/5-6-player';
    const button = document.createElement('button');
    button.id = 'base-rules-button'; button.type = 'button';
    button.title = 'Game rules'; button.setAttribute('aria-label', 'Open game rules');
    button.innerHTML = '<img src="/static/assets/catan/colonist/cities-knights/icon_book.svg" alt="">';
    root.querySelector('.board-panel').append(button);
    const dialog = document.createElement('dialog');
    dialog.id = 'base-rules-dialog'; dialog.className = 'ck-rules-dialog';
    root.append(dialog);
    const topic = (title, body) => `<section><h3>${title}</h3>${body}</section>`;
    function render(map) {
        const extended = map === 'base-56';
        dialog.innerHTML = `<header><div><span>${extended ? '5–6 player map' : 'Base game'}</span><h2>Game rules</h2></div><button type="button" data-close-rules aria-label="Close rules">×</button></header>
            <div class="ck-rules-scroll"><p>Place your starting pieces in snake order, then take turns rolling, trading and building. The first player to reach 10 victory points on their own turn wins.</p>
            <nav class="ck-rules-index" aria-label="Rule topics"><a href="#base-rule-setup">Setup</a><a href="#base-rule-build">Build</a><a href="#base-rule-dev">Development cards</a><a href="#base-rule-trade">Trade</a>${extended ? '<a href="#base-rule-special">Special Build Phase</a>' : ''}</nav>
            <div id="base-rule-setup">${topic('Setup and production', '<p>Each player places two settlements with a road from each. The second round runs in reverse order. Collect resources from hexes beside your second settlement. On a non-seven roll, each adjacent settlement receives one resource and each city receives two. The robber blocks its hex.</p>')}</div>
            ${topic('A seven and the robber', '<p>Players holding more than seven resource cards discard half, rounded down. The current player moves the robber to another hex and steals one random resource from a player with a building beside it.</p>')}
            <div id="base-rule-build">${topic('Build costs', '<div class="ck-rules-costs"><span>Road</span><b>Wood + brick</b><span>Settlement</span><b>Wood + brick + wheat + sheep</b><span>City</span><b>2 wheat + 3 ore</b><span>Development card</span><b>Wheat + sheep + ore</b></div><p>New settlements must be at least two edges from any other settlement or city and connect to one of your roads. Upgrade your own settlement to build a city. You have 15 roads, 5 settlements and 4 cities.</p>')}</div>
            <div id="base-rule-dev">${topic('Development cards', '<p>Play at most one development card per turn, including before rolling. A card bought this turn cannot be played until a later turn. Knights move the robber and count toward Largest Army. Road Building places two free roads; Year of Plenty takes two bank resources; Monopoly collects one resource type from all opponents. Victory Point cards stay secret until the win.</p>')}</div>
            <div id="base-rule-trade">${topic('Trading and ports', '<p>Trade with other players on your turn. The bank exchanges four identical resources for one chosen resource. A 3:1 port reduces that rate to three; a matching 2:1 port reduces it to two.</p>')}</div>
            ${topic('Victory points', '<p>Settlements are worth one point and cities two. Longest Road and Largest Army each award two points. Longest Road needs at least five connected roads; Largest Army needs at least three played knights. A tie does not take an award from its current holder.</p>')}
            ${extended ? `<div id="base-rule-special">${topic('5–6 player Special Build Phase', '<p>Request a Special Build Phase after another player’s normal turn. During it, you may build roads, settlements and cities or buy a development card. You cannot trade, play a development card or win until your normal turn. The extended board has 30 tiles, 24 of each resource card and 34 development cards.</p>')}</div>` : ''}
            <p class="ck-rules-source"><a href="${baseSource}" target="_blank" rel="noopener noreferrer">Read Colonist’s base rules ↗</a>${extended ? ` · <a href="${extendedSource}" target="_blank" rel="noopener noreferrer">Read Colonist’s 5–6 player rules ↗</a>` : ''}</p></div>`;
    }
    render('base');
    button.addEventListener('click', () => { if (!dialog.open) dialog.showModal(); });
    dialog.addEventListener('click', event => { if (event.target === dialog || event.target.closest('[data-close-rules]')) dialog.close(); });
    window.CatanClient?.subscribe(room => {
        button.hidden = room?.mode === 'cities-knights';
        if (button.hidden && dialog.open) dialog.close();
        render(room?.map || 'base');
    });
})();
