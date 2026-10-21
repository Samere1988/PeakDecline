/* In-game Cities & Knights reference, written from the Colonist rules. */
(() => {
    'use strict';
    const root = document.querySelector('.catan-app[data-online="true"]');
    if (!root) return;
    const A = '/static/assets/catan/colonist/cities-knights/';
    const source = 'https://colonist.io/catan-rules/cities-and-knights';
    const rail = document.createElement('nav');
    rail.id = 'ck-rule-tools'; rail.className = 'ck-panel'; rail.setAttribute('aria-label', 'Cities and Knights help');
    rail.innerHTML = `<button type="button" data-ck-settings title="Game settings" aria-label="Game settings" aria-expanded="false"><img src="${A}icon_settings.svg" alt=""></button><button type="button" data-ck-rules="full" title="Cities & Knights rules" aria-label="Open Cities & Knights rules"><img src="${A}icon_book.svg" alt=""></button><button type="button" data-ck-fullscreen title="Toggle fullscreen" aria-label="Toggle fullscreen"><img src="${A}icon_fullscreen_expand.svg" alt=""></button><button type="button" data-ck-rules="quick" title="Quick rules reference" aria-label="Open quick rules reference"><img src="${A}icon_info.svg" alt=""></button>`;
    const settings = document.createElement('div');
    settings.id = 'ck-settings-menu'; settings.className = 'ck-panel'; settings.hidden = true;
    settings.innerHTML = '<strong>Game settings</strong><button type="button" data-ck-sound>Sound on</button><button type="button" data-ck-fullscreen>Fullscreen</button>';
    const cards = entries => `<ul class="ck-rules-card-list">${entries.map(([name, rule]) => `<li><strong>${name}</strong><span>${rule}</span></li>`).join('')}</ul>`;
    const sections = [
        ['Setup', '<p>Place a settlement and road in the first setup round. In the reverse round, place a city and road. Play then proceeds from the first seat.</p>'],
        ['Dice and production', '<p>Each roll uses a red die, a regular die, and an event die. Add the two numbered dice for production. An event ship advances the barbarians; a colored castle may award a progress card when the red die matches a player’s improvement level.</p><p>Cities on wood, sheep, and ore produce one resource plus one commodity: paper, cloth, and coin respectively. Cities on wheat or brick produce two resources. Commodities count toward hand limits and can be traded.</p>'],
        ['Barbarian attack', '<p>The ship moves one step for each ship event. At the end of the track, compare the number of cities with the combined strength of every active knight. If the knights defend successfully, the strongest contributor earns a Defender point; tied leaders choose progress cards. If the barbarians win, eligible players with the least active strength each lose a city. Metropolises are safe. The ship resets and all knights become inactive after the attack.</p>'],
        ['Knights', '<p>A basic knight costs one sheep and one ore and must sit on your road network. One wheat activates it. Another sheep and ore upgrades it. You may have up to two knights at each of the three strengths; Politics level three unlocks mighty knights. Active knights contribute their level to the defense.</p><p>An active knight can move on your connected roads, push away a weaker opposing knight, or drive the robber from an adjacent tile. A knight action deactivates that knight. A newly placed and activated knight cannot also take an action that turn.</p>'],
        ['Robber and city walls', '<p>Before the first barbarian attack, a seven can still force discards, but the robber cannot move. A city wall costs two brick and raises your safe hand size by two. You can build at most three walls, one per city; a wall disappears if its city is lost.</p>'],
        ['City improvements', '<p>Science uses paper, Trade uses cloth, and Politics uses coin. You need at least one city to improve a discipline. The next level costs that many matching commodities: level one costs one, level two costs two, and so on through level five. The three-column chart beside each player shows these public levels.</p><p>At level three, Science grants the aqueduct resource choice when you receive no production on a non-seven roll; Trade gives a 2:1 commodity exchange; Politics permits mighty knights.</p>'],
        ['Metropolises', '<p>The first player to reach level four in a discipline can attach its metropolis to a city, gaining two extra points. A player reaching level five can take over that discipline’s metropolis. There is one metropolis per discipline, and barbarians cannot damage one.</p>'],
        ['Progress cards', '<p>Science, Trade, and Politics cards replace development cards. A colored castle on the event die can award a card when the red die falls within your matching improvement level. You normally hold at most four playable progress cards; you may briefly hold five on your own turn but must return one before ending it. Printed victory point cards are revealed instead of occupying a hand slot.</p>'],
        ['Science cards', cards([
            ['Alchemist', 'Choose both numbered dice before rolling on your turn.'],
            ['Crane', 'Pay one fewer commodity for a city improvement.'],
            ['Engineer', 'Add one city wall without paying brick.'],
            ['Inventor', 'Exchange two eligible number tokens; 2, 6, 8, and 12 stay put.'],
            ['Irrigation', 'Take two wheat for each wheat hex beside one of your buildings.'],
            ['Medicine', 'Promote a settlement for two ore and one wheat.'],
            ['Mining', 'Take two ore for each ore hex beside one of your buildings.'],
            ['Printer', 'Reveal one victory point.'],
            ['Road Building', 'Place two roads at no resource cost.'],
            ['Smith', 'Upgrade as many as two of your knights without paying.'],
        ])],
        ['Trade cards', cards([
            ['Commercial Harbor', 'Offer a resource to each opponent in exchange for a commodity.'],
            ['Master Merchant', 'Inspect the cards of a player ahead on points and take two.'],
            ['Merchant Fleet', 'Choose one card type to exchange at 2:1 for this turn.'],
            ['Merchant', 'Place the merchant beside your building for a point and a 2:1 trade rate on that hex’s resource.'],
            ['Resource Monopoly', 'Each opponent gives you up to two of the chosen resource.'],
            ['Commodity Monopoly', 'Each opponent gives you one of the chosen commodity, if held.'],
        ])],
        ['Politics cards', cards([
            ['Bishop', 'Relocate the robber and take a card from each affected opponent.'],
            ['Constitution', 'Reveal one victory point.'],
            ['Deserter', 'Make an opponent remove one knight, then place one of yours if possible.'],
            ['Diplomat', 'Remove an open road; if it was yours, you may place it elsewhere.'],
            ['Intrigue', 'Displace an opposing knight next to one of your roads.'],
            ['Saboteur', 'Players at or above your score discard half their resource and commodity cards.'],
            ['Spy', 'Look through one opponent’s progress cards and take one.'],
            ['Warlord', 'Activate all your knights without paying wheat.'],
            ['Wedding', 'Players ahead on points each hand over two resource or commodity cards.'],
        ])],
        ['Winning', '<p>Reach 13 victory points on your own turn to win. Settlements, cities, metropolises, the Longest Road, Defender awards, the merchant, and revealed point cards can contribute.</p>'],
    ];
    const dialog = document.createElement('dialog');
    dialog.id = 'ck-rules-dialog'; dialog.className = 'ck-rules-dialog';
    dialog.innerHTML = `<header><div><span>Cities & Knights</span><h2>Game rules</h2></div><button type="button" data-ck-rules-close aria-label="Close rules">×</button></header><nav class="ck-rules-tabs" aria-label="Rules view"><button type="button" data-ck-rules-view="quick">Quick guide</button><button type="button" data-ck-rules-view="full">Detailed guide</button><a href="${source}" target="_blank" rel="noopener noreferrer">Colonist’s full rules ↗</a></nav><div class="ck-rules-scroll"><section class="ck-rules-quick"><h3>Turn at a glance</h3><ol><li>Roll the three dice, or play Alchemist before the roll.</li><li>Collect resources and commodities, advance barbarians or draw progress cards.</li><li>Trade, build, improve cities, use knights, and play progress cards.</li><li>End your turn with no more than four playable progress cards.</li></ol><h3>Common costs</h3><div class="ck-rules-costs"><span>Road</span><b>Wood + brick</b><span>Settlement</span><b>Wood + brick + wheat + sheep</b><span>City</span><b>2 wheat + 3 ore</b><span>Knight / upgrade</span><b>Sheep + ore</b><span>Activate knight</span><b>Wheat</b><span>City wall</span><b>2 brick</b><span>Improvement</span><b>Matching commodity × new level</b></div><p>Barbarian strength equals cities on the board. Active knights defend together. First to 13 points on your turn wins.</p></section><div class="ck-rules-full"><p class="ck-rules-intro">Select a topic below. This reference summarizes the rules used by the expansion.</p><nav class="ck-rules-index" aria-label="Rule topics">${sections.map(([heading], i) => `<a href="#ck-rule-${i}">${heading}</a>`).join('')}</nav>${sections.map(([heading, body], i) => `<section id="ck-rule-${i}"><h3>${heading}</h3>${body}</section>`).join('')}</div><p class="ck-rules-source"><a href="${source}" target="_blank" rel="noopener noreferrer">Read the complete Colonist rules</a></p></div>`;
    root.querySelector('.board-panel').append(rail, settings, dialog);
    const show = mode => {
        dialog.dataset.view = mode;
        dialog.querySelectorAll('[data-ck-rules-view]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.ckRulesView === mode)));
        if (!dialog.open) dialog.showModal();
        dialog.querySelector('.ck-rules-scroll').scrollTop = 0;
    };
    rail.addEventListener('click', event => {
        if (event.target.closest('[data-ck-settings]')) {
            settings.hidden = !settings.hidden;
            rail.querySelector('[data-ck-settings]').setAttribute('aria-expanded', String(!settings.hidden));
            settings.querySelector('[data-ck-sound]').textContent = root.querySelector('#sound-toggle').textContent;
            return;
        }
        if (event.target.closest('[data-ck-fullscreen]')) {
            if (document.fullscreenElement) document.exitFullscreen();
            else document.documentElement.requestFullscreen?.().catch(() => {});
            return;
        }
        const button = event.target.closest('[data-ck-rules]');
        if (button) show(button.dataset.ckRules);
    });
    settings.addEventListener('click', event => {
        if (event.target.closest('[data-ck-sound]')) {
            const muted = window.CatanAudio.toggle();
            const control = root.querySelector('#sound-toggle');
            control.textContent = muted ? 'Sound off' : 'Sound on';
            control.setAttribute('aria-pressed', String(!muted));
            event.target.textContent = control.textContent;
        }
        if (event.target.closest('[data-ck-fullscreen]')) {
            if (document.fullscreenElement) document.exitFullscreen();
            else document.documentElement.requestFullscreen?.().catch(() => {});
        }
    });
    document.addEventListener('fullscreenchange', () => {
        const active = Boolean(document.fullscreenElement);
        rail.querySelector('[data-ck-fullscreen] img').src = `${A}icon_fullscreen_${active ? 'contract' : 'expand'}.svg`;
        settings.querySelector('[data-ck-fullscreen]').textContent = active ? 'Exit fullscreen' : 'Fullscreen';
    });
    document.addEventListener('pointerdown', event => {
        if (!settings.hidden && !settings.contains(event.target) && !rail.contains(event.target)) {
            settings.hidden = true;
            rail.querySelector('[data-ck-settings]').setAttribute('aria-expanded', 'false');
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !settings.hidden) {
            settings.hidden = true;
            rail.querySelector('[data-ck-settings]').setAttribute('aria-expanded', 'false');
        }
    });
    dialog.addEventListener('click', event => {
        if (event.target.closest('[data-ck-rules-close]') || event.target === dialog) dialog.close();
        const tab = event.target.closest('[data-ck-rules-view]');
        if (tab) show(tab.dataset.ckRulesView);
    });
    window.CatanClient.subscribe(room => {
        if (room?.game?.mode !== 'cities-knights') {
            if (dialog.open) dialog.close();
            settings.hidden = true;
            rail.querySelector('[data-ck-settings]').setAttribute('aria-expanded', 'false');
        }
    });
})();
