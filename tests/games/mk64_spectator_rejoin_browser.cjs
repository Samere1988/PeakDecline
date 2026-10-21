/* Keep the MK64 entry point; share the actual video/rejoin regression harness. */
process.env.SPECTATOR_GAMES = 'mk64';
process.env.LOBBY_TEST_URL = process.env.MK64_TEST_URL || 'http://127.0.0.1:8078';
if (process.env.MK64_PLAYWRIGHT) process.env.PLAYWRIGHT_PATH = process.env.MK64_PLAYWRIGHT;
if (process.env.MK64_BROWSER) process.env.BROWSER_PATH = process.env.MK64_BROWSER;
process.env.SPECTATOR_RESULTS ||= '.tmp/mk64-spectator-rejoin';
require('./all_spectator_rejoin_browser.cjs');
