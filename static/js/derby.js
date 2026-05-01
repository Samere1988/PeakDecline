/* static/js/derby.js */

document.addEventListener('DOMContentLoaded', () => {
    const TOTAL_HORSES = 10;
    const PAYOUT_MULTIPLIER = 9;

    const horses = [];
    for (let i = 1; i <= TOTAL_HORSES; i++) {
        horses.push(document.getElementById(`horse-${i}`));
    }

    const btnStart = document.getElementById('btn-start');
    const btnReset = document.getElementById('btn-reset');
    const announcer = document.getElementById('race-announcer');

    const bankrollDisplay = document.getElementById('bankroll-display');
    const betAmountInput = document.getElementById('bet-amount');
    const horseSelect = document.getElementById('horse-select');

    const trackWidth = document.querySelector('.race-track-wrapper').clientWidth;
    const finishLineX = trackWidth - 80;

    let raceInterval;
    let isRacing = false;
    let horsePositions = Array(TOTAL_HORSES).fill(10);

    let bankroll = 1000;
    let currentBet = 0;
    let selectedHorseIndex = 0;

    function updateBankroll() {
        bankrollDisplay.innerText = `$${bankroll}`;
    }

    function startRace() {
        if (isRacing) return;

        currentBet = parseInt(betAmountInput.value);
        selectedHorseIndex = parseInt(horseSelect.value) - 1;

        if (isNaN(currentBet) || currentBet <= 0 || currentBet > bankroll) {
            alert("Invalid bet amount! Make sure you have enough in your bankroll.");
            return;
        }

        bankroll -= currentBet;
        updateBankroll();

        isRacing = true;
        btnStart.disabled = true;
        horseSelect.disabled = true;
        betAmountInput.disabled = true;

        announcer.innerText = "And they're off! 🎺";
        announcer.style.color = "#fff";
        horses.forEach(h => h.classList.add('racing'));

        raceInterval = setInterval(() => {
            for (let i = 0; i < horses.length; i++) {
                let speed = Math.random() * 5 + 1.0;
                horsePositions[i] += speed;

                // Move the horse relative to the left side
                horses[i].style.left = horsePositions[i] + 'px';

                if (horsePositions[i] >= finishLineX) {
                    endRace(i);
                    break;
                }
            }
        }, 50);
    }

    function endRace(winningIndex) {
        clearInterval(raceInterval);
        isRacing = false;

        horses.forEach(h => h.classList.remove('racing'));
        horses[winningIndex].style.transform = "scale(1.4)";
        horses[winningIndex].style.zIndex = "10";

        if (winningIndex === selectedHorseIndex) {
            let winnings = currentBet * PAYOUT_MULTIPLIER;
            bankroll += winnings;
            updateBankroll();
            announcer.innerHTML = `🏆 Horse #${winningIndex + 1} wins! You won $${winnings}!`;
            announcer.style.color = "#4CAF50";
        } else {
            announcer.innerHTML = `🏆 Horse #${winningIndex + 1} wins! You lost your $${currentBet} wager.`;
            announcer.style.color = "#e50914";
        }

        btnStart.style.display = 'none';
        btnReset.style.display = 'inline-block';

        if (bankroll <= 0) {
            announcer.innerHTML += "<br><span style='font-size:0.6em; color:#aaa;'>Bankrupt! Management took pity and reset your bankroll to $1000.</span>";
            bankroll = 1000;
            updateBankroll();
        }
    }

    function resetRace() {
        horsePositions = Array(TOTAL_HORSES).fill(10);
        horses.forEach(horse => {
            // Reset position to the left side
            horse.style.left = '10px';
            horse.style.transform = "scale(1)";
            horse.style.zIndex = "2";
        });

        announcer.innerText = "Place your bets!";
        announcer.style.color = "#e5a00d";

        horseSelect.disabled = false;
        betAmountInput.disabled = false;

        btnReset.style.display = 'none';
        btnStart.style.display = 'inline-block';
        btnStart.disabled = false;
    }

    btnStart.addEventListener('click', startRace);
    btnReset.addEventListener('click', resetRace);
});