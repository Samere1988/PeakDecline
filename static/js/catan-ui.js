/* Shared Colonist-style game chrome for every Catan mode and map. */
(() => {
    'use strict';
    const A = '/static/assets/catan/colonist/';
    const colors = ['red', 'blue', 'orange', 'green', 'purple', 'white'];
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
    const image = (src, className = '', alt = '') => `<img class="${className}" src="${src}" alt="${escape(alt)}" draggable="false">`;
    const cardStat = ({src, count, label, className = ''}) => `<div class="card-stat ${className}" title="${escape(label)}" aria-label="${escape(label)}">${image(src)}<span>${escape(count)}</span></div>`;
    function seat({player, index, current, viewer = null, finished = false, secondCard, cardCount, extras = '', colorIndex = index, className = '', expansion = false}) {
        const color = colors[colorIndex] || colors[index % colors.length];
        const points = finished && player.totalVP != null ? player.totalVP : viewer === index && player.totalVP > player.vp ? `${player.vp}(${player.totalVP})` : player.vp;
        const pointLabel = viewer === index && player.totalVP > player.vp ? `${player.vp} public points; ${player.totalVP} including hidden cards` : `${player.vp} public points`;
        const ckCard = expansion ? 'ck-seat-card' : '';
        return `<div class="player-row ${className} ${index === current ? 'active' : ''}"><div class="seat-identity"><span class="player-name" title="${escape(player.name)}${viewer === index ? ' (you)' : ''}" aria-label="${escape(player.name)}${viewer === index ? ', you' : ''}">${escape(player.name)}</span><div class="seat-avatar" title="${escape(pointLabel)}">${image(`${A}player-${color}.svg`, `seat-frame ${expansion ? 'ck-seat-avatar-bg' : ''}`)}${image(`${A}player-icon.svg`, 'seat-person')}${image(`${A}ribbon.svg`, 'seat-ribbon')}<strong>${escape(points)}</strong></div></div><div class="seat-stats">${cardStat({src:`${A}card-hidden.svg`,count:cardCount,label:`Resource cards: ${cardCount}`,className:`seat-resource-cards ${ckCard}`})}${cardStat({src:secondCard.src,count:secondCard.count,label:secondCard.label,className:`seat-special-cards ${ckCard}`})}${extras}</div></div>`;
    }
    function bank({cards, progressCards = [], className = ''}) {
        const stock = cards.map(card => cardStat({...card, className:`${card.className || ''} ${card.count === 0 ? 'unavailable-card' : ''}`})).join('');
        const progress = progressCards.length ? `<div class="ck-bank-progress">${progressCards.map(card => cardStat({...card, className:`${card.className || ''} ${card.count === 0 ? 'unavailable-card' : ''}`})).join('')}</div>` : '';
        return `<div class="bank-stock ${className}">${image(`${A}bank.svg`, 'bank-icon', 'Resource bank')}${stock}</div>${progress}`;
    }
    function dice(values, event = null) {
        if (!values) return '';
        const faces = values.map((value, index) => image(event && index === 0 ? `${A}cities-knights/dice_red_${value}.svg` : `${A}dice-${value}.svg`, 'die', `${event && index === 0 ? 'Red die' : 'Die'}: ${value}`)).join('');
        const eventFace = event ? image(`${A}cities-knights/dice_event_${event}.svg`, 'die', `Event die: ${event}`) : '';
        return `${faces}<strong>${values[0] + values[1]}</strong>${eventFace}<span>Last roll</span>`;
    }
    window.CatanUI = Object.freeze({bank, cardStat, dice, seat});
})();
