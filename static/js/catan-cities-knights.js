/* Cities & Knights controls. All moves are checked by the expansion server. */
(() => {
    'use strict';
    const client = window.CatanClient, engine = window.CatanEngine, UI = window.CatanUI;
    const root = document.querySelector('.catan-app');
    if (!client || !root) return;
    const style = document.createElement('link');
    style.rel = 'stylesheet'; style.href = '/static/css/catan-cities-knights.css?v=shared-ui-v2';
    document.head.append(style);
    const $ = selector => root.querySelector(selector);
    $('.board-toolbar .toolbar-actions').prepend($('#turn-label'), $('#dice-display'));
    const A = '/static/assets/catan/colonist/cities-knights/';
    const R = ['wood', 'brick', 'wheat', 'sheep', 'ore'];
    const C = ['paper', 'cloth', 'coin'];
    const K = [...R, ...C];
    const colors = ['red', 'blue', 'orange', 'green', 'purple', 'white'];
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
    const title = value => String(value).replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
    const img = (file, alt = '') => `<img src="${A}${file}.svg" alt="${esc(alt)}">`;
    let room = null, activeTab = 'city', selectedCityAction = null, openTray = null, pendingBuild = null, selectedKnight = null, ckChatInitialized = false, originalChatOpen = false;
    const expansion = () => room?.game?.mode === 'cities-knights';
    const game = () => room.game;
    const mine = () => room.seat === null ? null : game().players[room.seat];
    const turn = () => room.seat !== null && room.seat === game().current;
    const enabled = () => turn() && game().phase === 'build';
    const constructing = () => turn() && ['build', 'special-build'].includes(game().phase);
    const hand = card => (R.includes(card) ? mine()?.resources?.[card] : mine()?.commodities?.[card]) || 0;
    const playerOptions = (filter = () => true) => game().players.map((player, index) => filter(player, index) ? `<option value="${index}">${esc(player.name)}</option>` : '').join('');
    const vertexOptions = (filter = () => true) => engine.vertices.map(vertex => filter(vertex.id) ? `<option value="${vertex.id}">Corner ${vertex.id + 1}</option>` : '').join('');
    const tileOptions = (filter = () => true) => game().tiles.map(tile => filter(tile) ? `<option value="${tile.id}">${esc(tile.type)} ${tile.number || ''} · tile ${tile.id + 1}</option>` : '').join('');
    const roadOptions = (filter = () => true) => engine.edges.map(edge => filter(edge.id) ? `<option value="${edge.id}">Road ${edge.id + 1}</option>` : '').join('');
    const select = (name, options, label = title(name), multiple = false) => `<label>${esc(label)}<select name="${name}" ${multiple ? 'multiple size="5"' : ''} required>${options}</select></label>`;
    const mapped = (map, name, options, label, multiple = false) => select(name, options, label, multiple).replace('<select ', `<select data-ck-map="${map}" `);
    const cardOptions = kinds => kinds.map(card => `<option value="${card}">${title(card)}</option>`).join('');
    const submit = (text = 'Confirm') => `<button type="submit">${esc(text)}</button>`;
    const form = (type, body, text = 'Confirm', extra = '') => `<form class="ck-form" data-ck-action="${type}" ${extra}>${body}${submit(text)}</form>`;
    const card = (kind, number, remaining) => `<span class="ck-card" title="${number} ${title(kind)}">${R.includes(kind) ? `<img src="/static/assets/catan/colonist/card-${kind}.svg" alt="">` : img('card_' + kind)}<b>${number}</b>${remaining === undefined ? '' : `<small>${remaining} bank</small>`}</span>`;
    const improvementCommodity = {science:'paper',trade:'cloth',politics:'coin'};
    const improvementCost = discipline => ({[improvementCommodity[discipline]]:Math.min(5, (mine()?.improvements?.[discipline] || 0) + 1)});
    const actionCost = (action, discipline) => action === 'improve-city' ? improvementCost(discipline) : {
        'build-knight':{sheep:1,ore:1},'upgrade-knight':{sheep:1,ore:1},'activate-knight':{wheat:1},'build-wall':{brick:2}
    }[action] || {};
    const affordable = cost => Object.entries(cost).every(([kind, count]) => hand(kind) >= count);
    const ownCities = () => Object.entries(game().buildings).filter(([, b]) => b.owner === room.seat && b.kind === 'city').map(([id]) => Number(id));
    const ownKnights = () => Object.entries(game().knightPieces || {}).filter(([, k]) => k.owner === room.seat).map(([id]) => Number(id));
    const citySelect = (filter = () => true) => mapped('vertex', 'target', vertexOptions(id => ownCities().includes(id) && filter(id)), 'City');
    const anyCorner = () => mapped('vertex', 'target', vertexOptions(), 'Corner');
    const anyTile = () => mapped('tile', 'target', tileOptions(), 'Tile');
    const anotherPlayer = () => select('target', playerOptions((_, i) => i !== room.seat), 'Player');
    const cardSelect = (name = 'resource', kinds = K) => select(name, cardOptions(kinds), 'Card');
    const pending = () => game().progressPending || {};

    function progressFields(cardName) {
        const kind = cardName.split('_').slice(1).join('_');
        if (cardName === 'science_alchemist') return `${select('die-one', cardOptions([1,2,3,4,5,6]), 'Red die')}${select('die-two', cardOptions([1,2,3,4,5,6]), 'Yellow die')}`;
        if (kind === 'crane') return `${select('discipline', cardOptions(['science','trade','politics']), 'Improvement')}${citySelect()}`;
        if (kind === 'engineer') return citySelect();
        if (kind === 'medicine') return mapped('vertex', 'target', vertexOptions(id => game().legal?.city?.includes(id)), 'Settlement to upgrade');
        if (kind === 'inventor') return mapped('tile', 'targets', tileOptions(t => t.number && ![2,6,8,12].includes(t.number)), 'Select two tiles', true);
        if (kind === 'smith') return mapped('vertex', 'targets', vertexOptions(id => ownKnights().includes(id)), 'Select up to two knights', true);
        if (kind === 'bishop') return mapped('tile', 'target', tileOptions(tile => tile.id !== game().robber), 'Robber destination');
        if (kind === 'deserter') return select('target', playerOptions((_, i) => i !== room.seat && Object.values(game().knightPieces || {}).some(k => k.owner === i)), 'Opponent');
        if (kind === 'diplomat') return `${mapped('edge', 'road', roadOptions(), 'Open road')}<label>Replacement road (optional)<select data-ck-map="edge" name="destination"><option value="">Do not replace</option>${roadOptions()}</select></label>`;
        if (kind === 'intrigue') return anyCorner();
        if (kind === 'spy') return anotherPlayer();
        if (kind === 'master_merchant') return select('target', playerOptions((p, i) => i !== room.seat && p.vp > mine().vp), 'Player with more points');
        if (kind === 'merchant') return mapped('tile', 'target', tileOptions(tile => R.includes(tile.type) && tile.corners.some(id => game().buildings[id]?.owner === room.seat)), 'Adjacent producing tile');
        if (kind === 'merchant_fleet') return cardSelect('resource');
        if (kind === 'resource_monopoly') return cardSelect('resource', R);
        if (kind === 'commodity_monopoly') return cardSelect('commodity', C);
        return '';
    }

    function phaseChoices() {
        const s = game(), phase = s.phase, p = pending();
        if (phase === 'defender-reward' && s.defenderRewards?.[0] === room.seat)
            return form('defender-reward', select('discipline', cardOptions(['science','trade','politics']), 'Progress deck'), 'Draw card');
        if (phase === 'aqueduct' && s.aqueductChoices?.includes(room.seat))
            return form('aqueduct', select('resource', cardOptions(R.filter(r => s.bank[r])), 'Resource'), 'Take resource');
        if (phase === 'progress-discard' && s.progressOverflow === room.seat)
            return form('discard-progress', select('card', cardOptions(mine().progress || []), 'Progress card'), 'Return card');
        if (phase === 'discard' && s.discard?.some(d => d.owner === room.seat))
            return form('discard', select('resource', cardOptions(K.filter(k => hand(k))), 'Card to discard'), 'Discard one');
        if (phase === 'progress-forced-discard' && p.discards?.some(d => d.owner === room.seat))
            return form('progress-forced-discard', cardSelect('resource', K.filter(k => hand(k))), 'Discard one');
        if (phase === 'wedding-gift' && p.gifts?.some(d => d.owner === room.seat))
            return form('wedding-gift', cardSelect('resource', K.filter(k => hand(k))), 'Give one');
        if (phase === 'spy-take' && p.owner === room.seat)
            return form('spy-take', select('card', cardOptions(s.privatePreview?.progress || []), 'Visible progress card'), 'Take card');
        if (phase === 'merchant-take' && p.owner === room.seat)
            return form('merchant-take', cardSelect('card', K.filter(k => s.privatePreview?.cards?.[k])), 'Take card');
        if (phase === 'harbor-response' && p.target === room.seat)
            return form('harbor-response', cardSelect('commodity', C.filter(k => hand(k))), 'Exchange commodity');
        if (phase === 'steal' && turn()) return `<p>Choose a player in the board controls to steal one card.</p>`;
        if (phase === 'robber' && turn()) return `<p>Choose a highlighted tile to move the robber.</p>`;
        if (phase === 'setup-city' && turn()) return `<p>Place your starting city on a highlighted corner.</p>`;
        if (phase === 'free-road' && turn()) return `<p>Place your free road on a highlighted edge.</p>`;
        return '';
    }

    function renderHand() {
        const section = $('#ck-hand'), s = game(), me = mine();
        $('#ck-commodities').innerHTML = me ? C.map(k => `<span class="ck-trade-commodity" data-trade-resource="${k}" role="button" tabindex="0" aria-label="Select ${k} for trade" title="Select ${k} for trade">${card(k, me.commodities?.[k] || 0)}</span>`).join('') : '';
        $('#ck-progress-dock').innerHTML = me ? (me.progress || []).map((name, index) => `<span class="development-card-wrap"><button class="development-card" type="button" data-ck-open="progress" data-ck-card="${index}" title="${esc(title(name.split('_').slice(1).join('_')))} progress card" aria-label="Open ${esc(title(name.split('_').slice(1).join('_')))} progress card">${img('card_progress_' + name)}<span>${esc(title(name.split('_').slice(1).join('_')))}</span></button></span>`).join('') : '';
        if (!me) { section.innerHTML = '<p>Private progress cards are hidden while spectating.</p>'; return; }
        const cards = (me.progress || []).map((name, index) => {
            const canPlay = turn() && (s.phase === 'build' || name === 'science_alchemist' && s.phase === 'roll');
            return `<details class="ck-progress-card"><summary>${img('card_progress_' + name, title(name))}<span>${title(name.split('_').slice(1).join('_'))}</span></summary>${canPlay ? form('play-progress', `<input type="hidden" name="card" value="${name}">${progressFields(name)}`, 'Play card') : '<p>Play on your turn after rolling.</p>'}${s.phase === 'build' && turn() ? form('discard-progress', `<input type="hidden" name="card" value="${name}">`, 'Return without playing') : ''}</details>`;
        }).join('');
        section.innerHTML = `<div class="card-heading"><h2>Progress cards</h2><span>${(me.progress || []).length} in hand</span></div><div class="ck-progress-hand">${cards || '<p>No progress cards in hand.</p>'}</div>`;
        $('#hand-count').textContent = `${(me.cardCount ?? 0)} cards`;
    }

    function renderBank() {
        const s = game();
        const stock = (kind, count, src, label = title(kind)) => ({src, count, label:`${label}: ${count} left`, className:'ck-bank-card'});
        const resources = R.map(kind => stock(kind, s.bank[kind], `/static/assets/catan/colonist/card-${kind}.svg`));
        const commodities = C.map(kind => stock(kind, s.commodityBank[kind], `${A}card_${kind}.svg`));
        const progressDecks = ['science','trade','politics'].map(kind => stock(kind, s.progressDeckCounts?.[kind] ?? 0, `${A}card_progress_${kind}_back.svg`, `${title(kind)} deck`));
        $('#bank-resources').innerHTML = UI.bank({cards:[...resources,...commodities],progressCards:progressDecks,className:'ck-bank-stock'});
    }

    function renderStatus() {
        const s = game(), own = mine(), strength = s.players.map((_, i) => Object.values(s.knightPieces || {}).filter(k => k.owner === i && k.active).reduce((n, k) => n + k.level, 0));
        const roadCounts = s.players.map((_, i) => Object.values(s.roads || {}).filter(owner => owner === i).length);
        const cities = Object.values(s.buildings).filter(building => building.kind === 'city').length;
        const position = Math.max(0, Math.min(7, s.barbarianPosition || 0));
        const knightStrength = strength.reduce((sum, value) => sum + value, 0);
        const forces = `<span class="ck-track-forces"><span class="ck-force ck-force-ship" tabindex="0" role="img" aria-label="Barbarian strength ${cities}. One point per city on the board. The ship advances when a barbarian event is rolled.">${img('icon_barbarian_ship')}<b>${cities}</b><span class="ck-force-tooltip" role="tooltip"><strong>Barbarian strength: ${cities}</strong>One point for each city on the board. The ship advances when a barbarian event is rolled.</span></span><span class="ck-force ck-force-knights" tabindex="0" role="img" aria-label="Active knight strength ${knightStrength}. Total levels of all active knights. Match or exceed barbarian strength to defend Catan.">${img('icon_swords')}<b>${knightStrength}</b><span class="ck-force-tooltip" role="tooltip"><strong>Active knight strength: ${knightStrength}</strong>Total levels of all active knights. Match or exceed barbarian strength to defend Catan.</span></span></span>`;
        $('#ck-barbarian-track').innerHTML = `<div class="ck-track-heading">Barbarians <b>${position}/7</b></div><div class="ck-track-steps">${Array.from({length: 8}, (_, step) => `<div class="ck-track-step ${step === position ? 'current' : ''} ${step === 7 ? 'attack' : ''}" aria-label="${step === 7 ? 'Attack' : 'Space ' + step}${step === position ? ', current position' : ''}"><span class="ck-track-hex">${step === 7 ? img('barbarian_tracker_hex_attack', 'Attack') : `<img src="${A}barbarian_tracker_hex_step.png" alt="">`}</span>${step === position ? forces : ''}</div>`).join('')}</div>`;
        $('#buy-development').hidden = true;
        $('#dev-cards').textContent = own ? `Pieces left: ${own.road} roads · ${own.settlement} settlements · ${own.city} cities · ${Object.values(s.knightPieces || {}).filter(k => k.owner === room.seat).length} knights` : '';
        $('#dice-display').innerHTML = s.dice ? UI.dice(s.dice, s.eventDie) : '';
        const improvementGrid = player => `<div class="ck-improvement-grid" role="img" aria-label="City improvements: Science ${player.improvements?.science ?? 0} of 5, Trade ${player.improvements?.trade ?? 0} of 5, Politics ${player.improvements?.politics ?? 0} of 5">${Array.from({length: 5}, (_, row) => ['science','trade','politics'].map(kind => `<span class="ck-improvement-cell ${(player.improvements?.[kind] || 0) >= 5 - row ? 'filled' : ''}"></span>`).join('')).join('')}</div>`;
        $('#players').innerHTML = s.players.map((p, i) => UI.seat({player:p,index:i,current:s.current,viewer:room.seat,finished:s.phase==='finished',colorIndex:p.color??i,className:`ck-seat ${i===room.seat?'mine':''}`,expansion:true,cardCount:p.cardCount??0,secondCard:{src:`${A}card_progress_back.svg`,count:p.progressCount??0,label:'Progress cards'},extras:`${improvementGrid(p)}<span class="ck-seat-strength"><span title="${roadCounts[i]} roads">${img('icon_longest_road', 'Roads')}<b>${roadCounts[i]}</b></span><span title="Active knight strength ${strength[i]}">${img('icon_swords', 'Active knights')}<b>${strength[i]}</b></span></span>`})).join('');
    }

    function renderBoard() {
        const s = game(), board = $('#board .hex-board');
        if (!board) return;
        board.querySelectorAll('.ck-board-knight, .ck-board-wall, .ck-board-metropolis, .ck-board-merchant').forEach(piece => piece.remove());
        const position = id => { const v = engine.vertices[Number(id)]; return `left:${v.x}%;top:${v.y}%`; };
        for (const [id, piece] of Object.entries(s.knightPieces || {})) {
            const color = colors[s.players[piece.owner].color ?? piece.owner];
            const icon = `${A}knight_level${piece.level}_${piece.active ? 'active' : 'inactive'}_${color}.svg`;
            const label = `${esc(s.players[piece.owner].name)} level ${piece.level} ${piece.active ? 'active' : 'inactive'} knight at corner ${Number(id) + 1}`;
            board.insertAdjacentHTML('beforeend', piece.owner === room.seat
                ? `<button type="button" class="ck-board-knight ${Number(id) === selectedKnight ? 'selected' : ''}" data-ck-knight="${id}" style="${position(id)}" aria-label="${label}" aria-pressed="${Number(id) === selectedKnight}"><img src="${icon}" alt=""></button>`
                : `<span class="ck-board-knight ck-board-knight-rival" style="${position(id)}" role="img" aria-label="${label}"><img src="${icon}" alt=""></span>`);
        }
        for (const [id, building] of Object.entries(s.buildings)) {
            if (building.kind !== 'city') continue;
            const color = colors[s.players[building.owner].color ?? building.owner];
            if (building.wall) board.insertAdjacentHTML('beforeend', `<img class="ck-board-wall" style="${position(id)}" src="${A}city_wall_${color}.svg" alt="City wall at corner ${Number(id) + 1}">`);
            if (building.metropolis) board.insertAdjacentHTML('beforeend', `<img class="ck-board-metropolis" style="${position(id)}" src="${A}metropolis_${building.metropolis}.svg" alt="${title(building.metropolis)} metropolis at corner ${Number(id) + 1}">`);
        }
        if (s.merchant) {
            const t = s.tiles[s.merchant.tile], color = colors[s.players[s.merchant.owner].color ?? s.merchant.owner];
            board.insertAdjacentHTML('beforeend', `<img class="ck-board-merchant" style="left:${t.x + 10}%;top:${t.y - 4}%" src="${A}icon_merchant_${color}.svg" alt="Merchant on ${esc(t.type)} tile">`);
        }
    }

    let mapSelect = null;
    function showMapOptions(selectElement) {
        $('#board').querySelectorAll('.ck-map-option').forEach(marker => marker.remove());
        mapSelect = selectElement;
        if (!selectElement || !expansion()) return;
        const board = $('#board .hex-board'), type = selectElement.dataset.ckMap;
        if (!board) return;
        for (const option of selectElement.options) {
            if (option.value === '') continue;
            const id = Number(option.value);
            let x, y;
            if (type === 'vertex') ({x, y} = engine.vertices[id]);
            else if (type === 'tile') ({x, y} = game().tiles[id]);
            else { const [a,b] = engine.edges[id].ends.map(v => engine.vertices[v]); x = (a.x+b.x)/2; y = (a.y+b.y)/2; }
            const marker = document.createElement('button');
            marker.type = 'button'; marker.className = 'ck-map-option';
            marker.dataset.ckMapValue = option.value;
            marker.style.left = `${x}%`; marker.style.top = `${y}%`;
            marker.title = option.textContent; marker.setAttribute('aria-label', `Choose ${option.textContent}`);
            marker.textContent = type === 'tile' ? String(game().tiles[id].number || '◆') : String(id + 1);
            board.append(marker);
        }
    }

    const buildCostTooltip = document.createElement('div');
    buildCostTooltip.className = 'catan-cost-tooltip ck-build-cost-tooltip';
    buildCostTooltip.hidden = true;
    buildCostTooltip.setAttribute('role', 'tooltip');
    document.body.append(buildCostTooltip);
    let costAnchor = null;
    function hideBuildCost() { buildCostTooltip.hidden = true; costAnchor = null; }
    function showBuildCost(anchor) {
        if (!expansion()) return;
        const action = anchor.dataset.ckCost, discipline = anchor.dataset.ckDiscipline;
        const rows = action === 'city-improvements'
            ? ['science','trade','politics'].map(kind => [title(kind), improvementCost(kind)])
            : [[anchor.getAttribute('aria-label') || title(action), actionCost(action, discipline)]];
        if (!rows.some(([, cost]) => Object.keys(cost).length)) return;
        costAnchor = anchor;
        const cards = cost => `<div class="catan-cost-cards">${Object.entries(cost).map(([kind, count]) => `<span class="catan-cost-card ${hand(kind) >= count ? 'available' : 'missing'}" aria-label="${count} ${kind}: ${hand(kind) >= count ? 'available' : 'missing'}"><img src="${R.includes(kind) ? `/static/assets/catan/colonist/card-${kind}.svg` : `${A}card_${kind}.svg`}" alt="${title(kind)}"><b>${count}</b></span>`).join('')}</div>`;
        buildCostTooltip.innerHTML = rows.map(([label, cost]) => `<div class="ck-cost-row"><strong>${esc(label)}</strong>${cards(cost)}</div>`).join('');
        buildCostTooltip.hidden = false;
        const rect = anchor.getBoundingClientRect(), width = buildCostTooltip.offsetWidth;
        buildCostTooltip.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
        buildCostTooltip.style.top = `${rect.top >= buildCostTooltip.offsetHeight + 8 ? rect.top - buildCostTooltip.offsetHeight - 8 : rect.bottom + 8}px`;
    }
    root.addEventListener('pointerover', event => {
        const anchor = event.target.closest('[data-ck-cost]');
        if (anchor && anchor !== costAnchor) showBuildCost(anchor);
    });
    root.addEventListener('pointerout', event => {
        if (costAnchor && costAnchor.contains(event.target) && !costAnchor.contains(event.relatedTarget)) hideBuildCost();
    });
    root.addEventListener('focusin', event => {
        const anchor = event.target.closest('[data-ck-cost]');
        if (anchor) showBuildCost(anchor);
    });
    root.addEventListener('focusout', event => {
        if (costAnchor && costAnchor.contains(event.target) && !costAnchor.contains(event.relatedTarget)) hideBuildCost();
    });

    function eligibleBuildTargets(action, discipline) {
        const s = game(), knights = Object.values(s.knightPieces || {}).filter(piece => piece.owner === room.seat);
        if (action === 'build-knight') return knights.filter(piece => piece.level === 1).length >= 2 ? []
            : engine.vertices.filter(vertex => !s.buildings[vertex.id] && !s.knightPieces?.[vertex.id] && vertex.edges.some(edge => s.roads[edge] === room.seat)).map(vertex => vertex.id);
        if (action === 'improve-city') {
            const level = mine()?.improvements?.[discipline] || 0, holder = s.metropolises?.[discipline];
            if (level >= 5) return [];
            const claim = level + 1 >= 4 && (!holder || holder.owner !== room.seat && level + 1 > (s.players[holder.owner]?.improvements?.[discipline] || 0));
            return ownCities().filter(id => !(level + 1 === 4 || claim) || !s.buildings[String(id)].metropolis);
        }
        if (action === 'activate-knight') return ownKnights().filter(id => !s.knightPieces[String(id)].active);
        if (action === 'build-wall') return Object.values(s.buildings).filter(b => b.owner === room.seat && b.wall).length >= 3 ? []
            : ownCities().filter(id => !s.buildings[String(id)].wall);
        if (action === 'upgrade-knight') return ownKnights().filter(id => {
            const knight = s.knightPieces[String(id)];
            return knight.level < 3 && knight.upgradedTurn !== s.turn && (knight.level < 2 || mine()?.improvements?.politics >= 3)
                && knights.filter(piece => piece.level === knight.level + 1).length < 2;
        });
        if (action === 'move-knight') return ownKnights().filter(id => {
            const knight = s.knightPieces[String(id)];
            return enabled() && knight.active && knight.placedTurn < s.turn && (knight.activatedTurn ?? -1) < s.turn
                && knightDestinations(id).length;
        });
        return [];
    }

    function knightDestinations(start) {
        const s = game(), piece = s.knightPieces?.[String(start)];
        if (!piece || piece.owner !== room.seat) return [];
        const reached = new Set([start]), frontier = [start];
        while (frontier.length) {
            const vertex = frontier.pop();
            for (const edgeId of engine.vertices[vertex].edges) {
                if (s.roads[edgeId] !== room.seat) continue;
                const other = engine.edges[edgeId].ends.find(id => id !== vertex);
                const building = s.buildings[String(other)], knight = s.knightPieces?.[String(other)];
                if (reached.has(other) || building && building.owner !== room.seat) continue;
                reached.add(other);
                if (!knight || knight.owner === room.seat) frontier.push(other);
            }
        }
        return [...reached].filter(id => id !== start && !s.buildings[String(id)] &&
            (!s.knightPieces?.[String(id)] || s.knightPieces[String(id)].owner !== room.seat && piece.level > s.knightPieces[String(id)].level));
    }

    function phaseBoardChoice() {
        const s = game(), p = pending();
        if (s.phase === 'barbarian-loss' && s.barbarianLosses?.includes(room.seat))
            return {action:'barbarian-loss', label:'Pillage city: choose one of your unprotected cities.',
                targets:ownCities().filter(id => !s.buildings[String(id)].metropolis)};
        if (s.phase === 'deserter-pick' && p.target === room.seat)
            return {action:'deserter-pick', label:'Deserter: choose one of your knights to remove.', targets:ownKnights()};
        if (s.phase === 'deserter-place' && p.owner === room.seat)
            return {action:'deserter-place', label:'Deserter: choose an open corner on your road, or skip placement.',
                optional:true, targets:(() => {
                    const mine = Object.values(s.knightPieces || {}).filter(knight => knight.owner === room.seat);
                    const level = mine.filter(knight => knight.level === p.piece?.level).length < 2 ? p.piece?.level : 1;
                    if (mine.filter(knight => knight.level === level).length >= 2) return [];
                    return engine.vertices.filter(vertex => !s.buildings[String(vertex.id)] &&
                        !s.knightPieces?.[String(vertex.id)] && vertex.edges.some(edge => s.roads[edge] === room.seat)).map(vertex => vertex.id);
                })()};
        if (s.phase === 'relocate-knight' && s.displacedKnight?.owner === room.seat) {
            const displaced = s.displacedKnight, start = displaced.origin, reached = new Set([start]), frontier = [start];
            while (frontier.length) {
                const vertex = frontier.pop();
                for (const edgeId of engine.vertices[vertex].edges) {
                    if (s.roads[edgeId] !== room.seat) continue;
                    const other = engine.edges[edgeId].ends.find(id => id !== vertex);
                    const building = s.buildings[String(other)], knight = s.knightPieces?.[String(other)];
                    if (reached.has(other) || building && building.owner !== room.seat) continue;
                    reached.add(other);
                    if (!knight || knight.owner === room.seat) frontier.push(other);
                }
            }
            return {action:'relocate-knight', label:'Relocate knight: choose an open corner along your roads.',
                targets:[...reached].filter(id => id !== start && !s.buildings[String(id)] && !s.knightPieces?.[String(id)])};
        }
        return null;
    }

    function showBuildTargets() {
        $('#board').querySelectorAll('.ck-build-target').forEach(marker => marker.remove());
        const prompt = $('#ck-build-prompt');
        const forced = expansion() ? phaseBoardChoice() : null;
        if ((!pendingBuild && !forced) || !expansion()) { prompt.hidden = true; return; }
        const {action, discipline, source} = pendingBuild || forced;
        const targets = forced?.targets || (action === 'move-knight' && source !== undefined ? knightDestinations(source) : eligibleBuildTargets(action, discipline));
        const label = action === 'improve-city' ? `Improve ${title(discipline)}` : title(action);
        prompt.querySelector('span').textContent = forced ? forced.label : action === 'move-knight'
            ? source === undefined ? 'Move knight: choose an active knight.' : 'Move knight: choose a highlighted destination.'
            : `${label}: choose ${action === 'build-knight' ? 'an open corner on your road' : action === 'improve-city' ? 'one of your cities' : 'one of your knights'}.`;
        prompt.querySelector('[data-ck-cancel-build]').hidden = Boolean(forced);
        prompt.querySelector('[data-ck-skip-choice]').hidden = !forced?.optional;
        prompt.hidden = false;
        const board = $('#board .hex-board');
        if (!board) return;
        for (const id of targets) {
            const vertex = engine.vertices[id], marker = document.createElement('button');
            marker.type = 'button'; marker.className = 'ck-build-target';
            marker.dataset.ckBuildTarget = String(id);
            marker.style.left = `${vertex.x}%`; marker.style.top = `${vertex.y}%`;
            marker.setAttribute('aria-label', forced ? `${label.split(':')[0]} at corner ${id + 1}` : action === 'move-knight' ? `${source === undefined ? 'Move' : 'Move to'} corner ${id + 1}` : `${label} at corner ${id + 1}`);
            marker.title = marker.getAttribute('aria-label');
            marker.innerHTML = '<span aria-hidden="true">+</span>';
            board.append(marker);
        }
    }

    function closeTools() {
        root.classList.remove('ck-tools-open');
        selectedCityAction = null;
        showMapOptions(null);
    }

    function renderActions() {
        const s = game(), me = mine(), active = constructing();
        const choice = phaseChoices();
        const choicePanel = $('#ck-required-choice');
        choicePanel.innerHTML = choice ? `<h3>${title(s.phase)}</h3>${choice}` : '';
        const choiceForm = choicePanel.querySelector('form[data-ck-action]');
        choicePanel.hidden = !choiceForm;
        if (choiceForm) {
            const select = choiceForm.querySelector('select'), grid = document.createElement('div');
            grid.className = 'ck-required-cards';
            for (const option of select?.options || []) {
                if (!option.value) continue;
                const value = option.value, kind = R.includes(value) ? `/static/assets/catan/colonist/card-${value}.svg`
                    : C.includes(value) ? `${A}card_${value}.svg`
                    : ['science','trade','politics'].includes(value) ? `${A}card_progress_${value}_back.svg`
                    : `${A}card_progress_${value}.svg`;
                const button = document.createElement('button');
                button.type = 'button'; button.dataset.ckRequiredValue = value;
                button.dataset.ckRequiredField = select.name;
                button.setAttribute('aria-label', `${choiceForm.querySelector('button[type="submit"]')?.textContent || 'Choose'} ${option.textContent}`);
                button.innerHTML = `<img src="${kind}" alt=""><span>${esc(option.textContent)}</span>`;
                grid.append(button);
            }
            choiceForm.hidden = true;
            choicePanel.append(grid);
        }
        let content = '';
        if (active && activeTab === 'city') {
            if (selectedCityAction === 'tradehouse-exchange' && enabled() && me?.improvements?.trade >= 3) content = `<h3>Merchant Guild</h3>${form('tradehouse-exchange', cardSelect('give', C) + cardSelect('receive', K), 'Exchange 2 for 1')}`;
            if (selectedCityAction === 'harbor-offer' && enabled() && s.harborTargets?.length) content = `<h3>Commercial Harbor</h3>${form('harbor-offer', select('target', playerOptions((_, i) => s.harborTargets.includes(i)), 'Player') + cardSelect('resource', R.filter(k => hand(k))), 'Offer resource')}`;
        }
        $('#ck-actions').innerHTML = content;
    }

    function renderTabs() {
        $('#ck-actions').hidden = activeTab !== 'city';
        $('#ck-hand').hidden = activeTab !== 'progress';
    }

    function renderTray() {
        const s = game(), me = mine(), knights = Object.values(s.knightPieces || {}).filter(piece => piece.owner === room.seat);
        const walls = Object.values(s.buildings).filter(piece => piece.owner === room.seat && piece.wall).length;
        const wall = $('#ck-wall-action');
        wall.disabled = !constructing() || !eligibleBuildTargets('build-wall').length || walls >= 3 || (me?.resources?.brick || 0) < 2;
        wall.querySelector('b').textContent = Math.max(0, 3 - walls);
        const color = colors[me?.color ?? room.seat] || 'red';
        wall.querySelector('img').src = `${A}city_wall_${color}.svg`;
        for (const kind of ['road', 'settlement', 'city']) {
            const piece = $(`.action-tray [data-build="${kind}"] .build-piece-image`);
            if (piece) piece.src = `/static/assets/catan/colonist/${kind}-${color}.svg`;
        }
        const piece = s.knightPieces?.[String(selectedKnight)];
        if (!piece || piece.owner !== room.seat) selectedKnight = null;
        const current = selectedKnight === null ? null : s.knightPieces[String(selectedKnight)];
        const canAct = current && enabled() && current.active && current.placedTurn < s.turn && (current.activatedTurn ?? -1) < s.turn;
        const canUpgrade = current && constructing() && current.level < 3 && current.upgradedTurn !== s.turn && (current.level < 2 || me?.improvements?.politics >= 3) && (me?.resources?.sheep || 0) > 0 && (me?.resources?.ore || 0) > 0;
        const button = (action, asset, label, disabled, count) => {
            const costAction = ['activate','upgrade'].includes(action);
            return `<button type="button" class="ck-quick-tile ${disabled && costAction ? 'ck-unaffordable' : ''}" data-ck-knight-action="${action}" ${costAction ? `data-ck-cost="${action}-knight" aria-disabled="${disabled}"` : disabled ? 'disabled' : ''} title="${label}" aria-label="${label}"><img src="${asset}" alt=""><b>${count}</b></button>`;
        };
        const context = $('#ck-knight-context');
        context.hidden = !current || Boolean(openTray) || pendingBuild?.action === 'move-knight';
        context.innerHTML = current ? button('activate', `${A}knight_level1_active_white.svg`, 'Activate selected knight', current.active || !constructing() || (me?.resources?.wheat || 0) < 1, knights.filter(k => !k.active).length)
            + button('upgrade', `${A}knight_level2_inactive_white.svg`, 'Upgrade selected knight', !canUpgrade, knights.filter(k => k.level < 3).length)
            + button('move', `${A}knight_move_white.png`, 'Move selected knight', !canAct || !knightDestinations(selectedKnight).length, knights.filter(k => k.active).length)
            + button('chase', '/static/assets/catan/colonist/robber.svg', 'Chase robber with selected knight', !canAct || !s.barbarianAttacks || !engine.vertices[selectedKnight]?.tiles.includes(s.robber), Object.entries(s.knightPieces).filter(([id, knight]) => knight.owner === room.seat && knight.active && engine.vertices[Number(id)]?.tiles.includes(s.robber)).length) : '';
        const options = $('#ck-action-options');
        options.hidden = !openTray;
        if (openTray === 'knights') {
            const tile = (action, icon, label, count, extra = '') => `<button type="button" class="ck-quick-tile ck-option-tile ${affordable(actionCost(action)) && (!['build-knight','upgrade-knight','activate-knight','move-knight'].includes(action) || eligibleBuildTargets(action).length) ? '' : 'ck-unaffordable'}" data-ck-option="${action}" data-ck-cost="${action}" aria-disabled="${!affordable(actionCost(action)) || ['build-knight','upgrade-knight','activate-knight','move-knight'].includes(action) && !eligibleBuildTargets(action).length}" title="${label}" aria-label="${label}"><img src="${icon}" alt="">${extra}<b>${count}</b></button>`;
            options.innerHTML = tile('build-knight', `${A}knight_level1_inactive_white.svg`, 'Build knight', Math.max(0, 2 - knights.filter(k => k.level === 1).length))
                + tile('activate-knight', `${A}knight_level1_active_white.svg`, 'Activate knight', knights.filter(k => !k.active).length)
                + tile('upgrade-knight', `${A}knight_level1_inactive_white.svg`, 'Upgrade knight', knights.filter(k => k.level < 3).length, '<span class="ck-option-arrow" aria-hidden="true">↑</span>')
                + (enabled() ? tile('move-knight', `${A}knight_move_white.png`, 'Move knight', knights.filter(k => k.active).length) : '');
        } else if (openTray === 'city') {
            options.innerHTML = ['science', 'trade', 'politics'].map(discipline => `<button type="button" class="ck-quick-tile ck-option-tile ${affordable(improvementCost(discipline)) && eligibleBuildTargets('improve-city', discipline).length ? '' : 'ck-unaffordable'}" data-ck-option="improve-city" data-ck-cost="improve-city" data-ck-discipline="${discipline}" aria-disabled="${!affordable(improvementCost(discipline)) || !eligibleBuildTargets('improve-city', discipline).length}" title="Improve ${title(discipline)}" aria-label="Improve ${title(discipline)}"><img src="${A}icon_square_framed_${discipline}.svg" alt="">${me?.improvements?.[discipline] ? `<b>${me.improvements[discipline]}</b>` : ''}</button>`).join('')
                + (enabled() && me?.improvements?.trade >= 3 ? `<button type="button" class="ck-quick-tile ck-option-tile" data-ck-option="tradehouse-exchange" title="Merchant Guild exchange" aria-label="Merchant Guild exchange">${img('icon_square_framed_trade')}</button>` : '')
                + (enabled() && s.harborTargets?.length ? `<button type="button" class="ck-quick-tile ck-option-tile" data-ck-option="harbor-offer" title="Commercial Harbor" aria-label="Commercial Harbor">${img('card_progress_trade_commercial_harbor')}</button>` : '');
        } else options.innerHTML = '';
        $('#ck-knight-actions').setAttribute('aria-expanded', String(openTray === 'knights'));
        $('#ck-open-actions').setAttribute('aria-expanded', String(openTray === 'city'));
        const phase = {
            'setup-settlement': 'Place Settlement', 'setup-city': 'Place City', 'setup-road': 'Place Road',
            roll: 'Roll Dice', build: 'Build & Trade', 'special-build': 'Special Build', robber: 'Move Robber', discard: 'Discard Cards',
            'barbarian-loss': 'Barbarian Attack', 'progress-discard': 'Discard Progress Card', aqueduct: 'Choose a Resource',
        }[s.phase] || title(s.phase);
        $('#turn-label').textContent = `${s.players[s.current].name} · ${turn() && s.phase === 'roll' ? 'Your turn' : phase}`;
    }

    function render() {
        const active = expansion(); root.classList.toggle('cities-knights-mode', active);
        if (!active) {
            pendingBuild = null; hideBuildCost(); showBuildTargets();
            $('#buy-development').hidden = false; closeTools();
            if (ckChatInitialized) { $('#chat-panel .chat-toggle').open = originalChatOpen; ckChatInitialized = false; }
            return;
        }
        if (!ckChatInitialized) {
            const chat = $('#chat-panel .chat-toggle');
            originalChatOpen = chat.open; chat.open = true; ckChatInitialized = true;
        }
        if (room.status !== 'playing' || !constructing() || pendingBuild?.action === 'move-knight' && !enabled()) pendingBuild = null;
        if (phaseBoardChoice()) { closeTools(); openTray = null; selectedKnight = null; root.classList.remove('trading'); }
        if (room.status !== 'playing') closeTools();
        else showMapOptions(null);
        hideBuildCost();
        $('#toggle-sidebar').textContent = 'Players & chat';
        renderHand(); renderBank(); renderStatus(); renderBoard(); showBuildTargets(); renderActions(); renderTabs(); renderTray();
        if (!$('#ck-required-choice').hidden) { closeTools(); openTray = null; root.classList.remove('trading'); renderTray(); }
        if (game().phase === 'setup-city') $('#game-message').textContent = `${game().players[game().current].name}: place your starting city.`;
        if (game().phase === 'discard' && game().discard?.some(d => d.owner === room.seat)) $('#game-message').textContent = `Discard ${game().discard.find(d => d.owner === room.seat).left} more resource or commodity cards.`;
        if (game().phase === 'special-build') $('#game-message').textContent = `${game().players[game().current].name}: build pieces or improvements, or buy, activate, or upgrade knights. Finish when ready.`;
        if (game().phase === 'build') $('#game-message').textContent = '';
    }

    const section = (id, parent) => { const element = document.createElement('section'); element.id = id; element.className = 'ck-panel sidebar-card'; parent.append(element); return element; };
    const track = document.createElement('aside');
    track.id = 'ck-barbarian-track'; track.className = 'ck-panel'; track.setAttribute('aria-label', 'Barbarian progress');
    $('.board-panel').append(track);
    section('ck-commodities', $('.bottom-hand'));
    section('ck-progress-dock', $('.bottom-hand'));
    const workspace = section('ck-workspace', $('.board-panel'));
    workspace.innerHTML = '<div class="ck-workspace-heading"><strong>Progress cards</strong><button type="button" data-ck-close-tools aria-label="Close card details">×</button></div>';
    const choicePanel = document.createElement('section');
    choicePanel.id = 'ck-required-choice'; choicePanel.className = 'ck-required-choice'; choicePanel.hidden = true;
    $('.board-panel').append(choicePanel);
    section('ck-actions', workspace);
    section('ck-hand', workspace);
    const wallAction = document.createElement('button');
    wallAction.id = 'ck-wall-action'; wallAction.className = 'action-tile'; wallAction.type = 'button';
    wallAction.dataset.ckOpen = 'wall'; wallAction.dataset.ckCost = 'build-wall'; wallAction.title = 'Build a city wall: 2 brick'; wallAction.setAttribute('aria-label', 'Build a city wall');
    wallAction.innerHTML = `${img('city_wall_white', '')}<b>3</b><span>Wall</span>`;
    const roadAction = $('.action-tray [data-build="road"]');
    $('.action-tray').insertBefore(wallAction, roadAction.closest('.action-cost-anchor') || roadAction);
    const quickActions = document.createElement('div');
    quickActions.id = 'ck-quick-actions'; quickActions.className = 'ck-panel';
    quickActions.innerHTML = `<button id="ck-knight-actions" class="ck-quick-tile" type="button" data-ck-tray="knights" data-ck-cost="build-knight" title="Knights" aria-label="Build knight" aria-expanded="false">${img('knight_level1_inactive_white')}</button><button id="ck-open-actions" class="ck-quick-tile" type="button" data-ck-tray="city" data-ck-cost="city-improvements" title="City improvements" aria-label="Show city improvements" aria-expanded="false"><img src="${A}pageck_city_improvement_tracker.png" alt=""></button>`;
    $('.board-panel').append(quickActions);
    const buildPrompt = document.createElement('div');
    buildPrompt.id = 'ck-build-prompt'; buildPrompt.className = 'ck-panel'; buildPrompt.hidden = true;
    buildPrompt.innerHTML = '<span></span><button type="button" data-ck-skip-choice hidden>Skip</button><button type="button" data-ck-cancel-build>Cancel</button>';
    $('.board-panel').append(buildPrompt);
    const actionOptions = document.createElement('div');
    actionOptions.id = 'ck-action-options'; actionOptions.className = 'ck-panel'; actionOptions.hidden = true;
    $('.board-panel').append(actionOptions);
    const knightContext = document.createElement('div');
    knightContext.id = 'ck-knight-context'; knightContext.className = 'ck-panel'; knightContext.hidden = true;
    $('.board-panel').append(knightContext);
    root.addEventListener('submit', async event => {
        const element = event.target.closest('form[data-ck-action]');
        if (!element || !expansion()) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const values = new FormData(element), type = element.dataset.ckAction;
        const action = {type};
        for (const [key, value] of values) {
            if (key.startsWith('give-') || key.startsWith('want-') || key === 'amount') continue;
            if (key === 'targets') continue;
            if (value === '' && ['target', 'destination'].includes(key)) { action[key] = null; continue; }
            action[key] = ['target','destination','road'].includes(key) ? Number(value) : value;
        }
        if (type === 'play-progress') {
            if (action.card === 'science_alchemist') { action.dice = [Number(values.get('die-one')), Number(values.get('die-two'))]; delete action['die-one']; delete action['die-two']; }
            const targets = values.getAll('targets').map(Number);
            if (action.card === 'science_inventor' && targets.length !== 2 || action.card === 'science_smith' && targets.length > 2) { $('#online-notice').textContent = 'Choose the required number of board locations.'; return; }
            if (['science_inventor','science_smith'].includes(action.card)) action.targets = targets;
        }
        await client.action(action);
    }, true);
    root.addEventListener('click', async event => {
        if (!expansion()) return;
        const required = event.target.closest('[data-ck-required-value]');
        if (required && !$('#ck-required-choice').hidden) {
            event.preventDefault(); event.stopImmediatePropagation();
            const form = required.closest('#ck-required-choice').querySelector('form[data-ck-action]');
            if (form) await client.action({type:form.dataset.ckAction, [required.dataset.ckRequiredField]:required.dataset.ckRequiredValue});
            return;
        }
        if (event.target.closest('[data-ck-cancel-build]')) {
            event.preventDefault(); event.stopImmediatePropagation();
            pendingBuild = null; showBuildTargets();
            return;
        }
        if (event.target.closest('[data-ck-skip-choice]') && phaseBoardChoice()?.optional) {
            event.preventDefault(); event.stopImmediatePropagation();
            await client.action({type:phaseBoardChoice().action, target:null});
            return;
        }
        const buildTarget = event.target.closest('.ck-build-target');
        const forced = phaseBoardChoice();
        if (buildTarget && (pendingBuild || forced)) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (pendingBuild?.action === 'move-knight' && pendingBuild.source === undefined) {
                pendingBuild.source = Number(buildTarget.dataset.ckBuildTarget);
                selectedKnight = pendingBuild.source;
                renderBoard(); renderTray(); showBuildTargets();
                return;
            }
            const action = {type:(pendingBuild || forced).action, target:Number(buildTarget.dataset.ckBuildTarget)};
            if (pendingBuild?.action === 'move-knight') {
                action.target = pendingBuild.source;
                action.destination = Number(buildTarget.dataset.ckBuildTarget);
            }
            if (pendingBuild?.discipline) action.discipline = pendingBuild.discipline;
            const sent = await client.action(action);
            if (sent) { pendingBuild = null; selectedKnight = null; showBuildTargets(); }
            return;
        }
        if (event.target.closest('.action-tray [data-build]')) {
            setTimeout(render, 0);
            return;
        }
        if (event.target.closest('#ck-wall-action')) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (!$('#ck-wall-action').disabled) {
                pendingBuild = {action:'build-wall'};
                closeTools(); openTray = null; renderTray(); showBuildTargets();
            }
            return;
        }
        if (event.target.closest('[data-ck-close-tools]')) {
            event.preventDefault(); event.stopImmediatePropagation();
            closeTools();
            return;
        }
        const tray = event.target.closest('[data-ck-tray]');
        if (tray) {
            event.preventDefault(); event.stopImmediatePropagation();
            hideBuildCost();
            pendingBuild = null; showBuildTargets();
            closeTools();
            openTray = openTray === tray.dataset.ckTray ? null : tray.dataset.ckTray;
            selectedKnight = null;
            renderBoard(); renderTray();
            return;
        }
        const option = event.target.closest('[data-ck-option]');
        if (option) {
            event.preventDefault(); event.stopImmediatePropagation();
            hideBuildCost();
            const action = option.dataset.ckOption, discipline = option.dataset.ckDiscipline;
            if (['build-knight','upgrade-knight','activate-knight','improve-city','move-knight'].includes(action)) {
                if (option.getAttribute('aria-disabled') === 'true') {
                    $('#game-message').textContent = action === 'move-knight'
                        ? 'You need an active knight with a reachable destination.'
                        : 'You need the highlighted cards and an eligible board location for that action.';
                    return;
                }
                pendingBuild = {action, discipline};
                openTray = null; closeTools(); renderTray(); showBuildTargets();
                return;
            }
            activeTab = 'city';
            selectedCityAction = action;
            openTray = null;
            root.classList.add('ck-tools-open');
            renderActions(); renderTabs(); renderTray();
            $('#ck-workspace .ck-workspace-heading strong').textContent = discipline ? `${title(discipline)} improvement` : title(action);
            const forms = [...$('#ck-actions').querySelectorAll(`form[data-ck-action="${action}"]`)];
            const target = discipline ? forms.find(form => form.querySelector('input[name="discipline"]')?.value === discipline) : forms[0];
            target?.scrollIntoView({block: 'nearest'});
            target?.querySelector('select')?.focus();
            return;
        }
        const open = event.target.closest('[data-ck-open]');
        if (open) {
            event.preventDefault(); event.stopImmediatePropagation();
            activeTab = open.dataset.ckOpen || 'progress';
            selectedCityAction = null;
            openTray = null; root.classList.add('ck-tools-open'); renderTray();
            renderActions(); renderTabs();
            $('#ck-workspace .ck-workspace-heading strong').textContent = 'Progress cards';
            if (open?.dataset.ckCard !== undefined) {
                const card = $('#ck-hand .ck-progress-hand')?.children[Number(open.dataset.ckCard)];
                if (card?.tagName === 'DETAILS') { card.open = true; card.scrollIntoView({block: 'nearest'}); }
            }
            return;
        }
        const selected = event.target.closest('[data-ck-knight]');
        if (selected) {
            event.preventDefault(); event.stopImmediatePropagation();
            const id = Number(selected.dataset.ckKnight);
            selectedKnight = selectedKnight === id ? null : id;
            openTray = null;
            closeTools();
            renderBoard(); renderTray();
            return;
        }
        const knightAction = event.target.closest('[data-ck-knight-action]');
        if (knightAction && !knightAction.disabled && knightAction.getAttribute('aria-disabled') !== 'true' && selectedKnight !== null) {
            event.preventDefault(); event.stopImmediatePropagation();
            const kind = knightAction.dataset.ckKnightAction;
            if (kind === 'activate' || kind === 'upgrade' || kind === 'chase') {
                client.action({type: `${kind === 'chase' ? 'chase-robber' : kind + '-knight'}`, target: selectedKnight});
            } else {
                pendingBuild = {action:'move-knight', source:selectedKnight};
                closeTools(); renderTray(); showBuildTargets();
            }
            return;
        }
        const marker = event.target.closest('.ck-map-option');
        if (marker && mapSelect?.isConnected) {
            event.preventDefault(); event.stopImmediatePropagation();
            const option = [...mapSelect.options].find(item => item.value === marker.dataset.ckMapValue);
            const selected = mapSelect;
            if (option) { if (selected.multiple) option.selected = !option.selected; else selected.value = option.value; }
            showMapOptions(selected.multiple ? selected : null);
            return;
        }
    }, true);
    root.addEventListener('focusin', event => { if (event.target.matches('select[data-ck-map]')) showMapOptions(event.target); });
    root.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !expansion() || event.target.matches('select, input, textarea')) return;
        if (pendingBuild) { pendingBuild = null; showBuildTargets(); event.preventDefault(); return; }
        if (!root.classList.contains('ck-tools-open')) return;
        closeTools();
    });
    let receiptTimer;
    function receivedCards(previous, next) {
        if (!previous?.game || previous.id !== next.id || previous.seat !== next.seat ||
            next.seat === null || previous.gameRevision === next.gameRevision) return;
        const before = previous.game.players[next.seat], after = next.game.players[next.seat];
        const changes = K.map(kind => [kind, (R.includes(kind) ? after.resources?.[kind] - before.resources?.[kind]
            : after.commodities?.[kind] - before.commodities?.[kind]) || 0]);
        const gains = changes.filter(([, count]) => count > 0), losses = changes.filter(([, count]) => count < 0);
        if (!gains.length && !losses.length) return;
        const receipt = $('.card-receipt');
        const cards = items => items.map(([kind, count]) => `<span class="receipt-resource">${R.includes(kind) ? `<img src="/static/assets/catan/colonist/card-${kind}.svg" alt="${kind}">` : img('card_' + kind, kind)}<b>${Math.abs(count)}</b></span>`).join('');
        receipt.innerHTML = (gains.length ? '<span>Received</span>' + cards(gains) : '') + (losses.length ? '<span>Lost</span>' + cards(losses) : '');
        receipt.setAttribute('aria-label', [gains.length ? 'Received ' + gains.map(([kind, count]) => `${count} ${kind}`).join(', ') : '', losses.length ? 'Lost ' + losses.map(([kind, count]) => `${-count} ${kind}`).join(', ') : ''].filter(Boolean).join('; '));
        receipt.classList.add('visible');
        clearTimeout(receiptTimer);
        receiptTimer = setTimeout(() => receipt.classList.remove('visible'), 2800);
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        const bank = $('#bank-resources')?.getBoundingClientRect();
        if (!bank) return;
        let index = 0;
        for (const [kind, count] of losses) {
            const source = (R.includes(kind) ? $(`[data-resource="${kind}"]`) : root.querySelectorAll('#ck-commodities .ck-card')[C.indexOf(kind)])?.getBoundingClientRect();
            if (!source) continue;
            for (let n = 0; n < Math.min(-count, 3) && index < 10; n++, index++) {
                const card = document.createElement('img');
                card.className = 'received-card'; card.alt = ''; card.setAttribute('aria-hidden', 'true');
                card.src = R.includes(kind) ? `/static/assets/catan/colonist/card-${kind}.svg` : `${A}card_${kind}.svg`;
                document.body.append(card);
                const animation = card.animate([
                    {transform: `translate(${source.x + source.width / 2 - 18}px,${source.y + source.height / 2 - 27}px) scale(1)`, opacity: 1},
                    {offset: .85, opacity: 1},
                    {transform: `translate(${bank.x + bank.width / 2 - 18}px,${bank.y + bank.height / 2 - 27}px) scale(.65)`, opacity: 0}
                ], {duration: 850, delay: index * 65, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both'});
                animation.finished.then(() => card.remove(), () => card.remove());
            }
        }
    }
    function expansionSounds(previous, next) {
        if (!previous?.game || previous.id !== next.id ||
            previous.game.mode !== 'cities-knights' || next.game?.mode !== 'cities-knights' ||
            previous.gameRevision === next.gameRevision) return [];
        const before = previous.game, after = next.game, sounds = [];
        const add = name => { if (!sounds.includes(name)) sounds.push(name); };
        const oldBuildings = before.buildings || {}, buildings = after.buildings || {};
        const oldKnights = before.knightPieces || {}, knights = after.knightPieces || {};
        if (after.audioEvent?.id !== before.audioEvent?.id && after.audioEvent?.cue) add(after.audioEvent.cue);
        if (before.winner == null && after.winner != null) add('sfx_victory');
        if ((after.rolls?.length || 0) > (before.rolls?.length || 0)) add('sfx_dice_roll_1');
        if (Object.keys(oldBuildings).some(id => oldBuildings[id].kind === 'city' && buildings[id]?.kind === 'settlement')) add('sfx_city_destroy');
        if (Object.keys(after.metropolises || {}).some(kind =>
            JSON.stringify(before.metropolises?.[kind]) !== JSON.stringify(after.metropolises[kind]))) add('sfx_metropolis_place');
        if (after.players.some((player, i) => (player.progressVP?.length || 0) > (before.players[i]?.progressVP?.length || 0) ||
            (player.defenderVP || 0) > (before.players[i]?.defenderVP || 0))) add('sfx_achievement_ck_progress');
        if (Object.keys(buildings).some(id => buildings[id].wall && !oldBuildings[id]?.wall)) add('sfx_city_wall_place');
        if (after.players.some((player, i) => Object.keys(player.improvements || {}).some(kind =>
            player.improvements[kind] > (before.players[i]?.improvements?.[kind] || 0)))) add('sfx_city_improvement');
        if (Object.keys(knights).some(id => oldKnights[id]?.owner === knights[id].owner &&
            knights[id].level > oldKnights[id].level)) add('sfx_knight_upgrade');
        if (Object.keys(knights).length > Object.keys(oldKnights).length) add('sfx_knight_place');
        if (Object.keys(knights).some(id => oldKnights[id]?.owner === knights[id].owner &&
            !oldKnights[id].active && knights[id].active)) add('sfx_knight_equip');
        if (Object.keys(buildings).some(id => buildings[id].kind === 'city' && oldBuildings[id]?.kind !== 'city')) add('sfx_city_place');
        else if (Object.keys(buildings).some(id => buildings[id].kind === 'settlement' && !oldBuildings[id])) add('sfx_settlement_place');
        if (Object.keys(after.roads || {}).length > Object.keys(before.roads || {}).length) add('sfx_road_place');
        if ((after.barbarianPosition || 0) > (before.barbarianPosition || 0)) add('sfx_ship_move');
        if (after.robber !== before.robber) add('sfx_robber_place');
        if (after.players[after.current] && after.current !== before.current && next.seat === after.current) add('sfx_your_turn');
        return sounds.slice(0, 3);
    }
    client.subscribe(next => {
        const previous = room;
        if (previous?.id !== next?.id || previous?.game?.mode !== next?.game?.mode) { selectedKnight = null; openTray = null; pendingBuild = null; }
        room = next;
        render();
        if (expansion()) {
            expansionSounds(previous, next).forEach(name => window.CatanAudio?.play(name));
            receivedCards(previous, next);
        }
    });
})();
