// Deterministic checks for the browser/native boundary, without game assets.
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');

test('native reads see current controller input without waiting for a UI timer', async () => {
 let pad = {x: 0, y: 0, buttons: 0}, reads = 0;
 const bridge = {readPad: () => {reads++;return pad;}, session: {}};
 const canvas = {getContext: () => ({})}, loading = {};
 const context = vm.createContext({
  parent: {peakCMR2Bridge: bridge},
  document: {body: {dataset: {buildUrl: '/build/', assetUrl: '/data/'}},
   getElementById: id => id === 'canvas' ? canvas : loading, createElement: () => canvas},
  navigator: {gpu: {requestAdapter: () => new Promise(() => {})}},
  clearInterval() {}, console,
 });
 context.window = context;context.addEventListener = () => {};
 vm.runInContext(source('static/js/netplay/cmr2_runtime.js'), context);
 assert.equal(context.Module.cmr2Pad.buttons, 0);
 pad = {x: 70, y: 0, buttons: 0x8000};
 assert.equal(context.Module.cmr2Pad, pad, 'the very next native read must see the press');
 pad = {x: 0, y: 0, buttons: 0};
 assert.equal(context.Module.cmr2Pad, pad, 'releases must not remain cached');
 assert.equal(reads, 3);
 await context.peakShutdown();
 assert.equal(context.Module.cmr2Pad.buttons, 0);
 assert.equal(reads, 3, 'shutdown must stop controller polling');
});

function session() {
 const handlers = new Map(), sent = [];
 const socket = {connected: true, io: {engine: {writeBuffer: [], transport: {writable: true}}},
  on: (name, fn) => handlers.set(name, fn), off: name => handlers.delete(name),
  emit: (name, message) => sent.push({name, message})};
 socket.volatile = socket;
 const backends = new Map();
 vm.runInNewContext(source('static/js/netplay/cmr2_session.js'), {PeakNet: {backends}, Uint8Array});
 const Session = backends.get('cmr2-server-relay-v1');
 const game = new Session({socket, players: 2, slot: 0, epoch: 7, onFailure() {}});
 game.running = true;game.hasSpectators = true;
 return {game, socket, handlers, sent};
}

test('spectator encoding and sending require the current coordinator and a clear transport', () => {
 const {game, socket, sent} = session();
 assert.equal(game.canBroadcast(), true);
 game.broadcast('video', new Uint8Array([1]));
 assert.equal(sent.length, 1);
 for (const block of [
  () => {game.slot = 1;},
  () => {game.hasSpectators = false;},
  () => {game.spectator = true;},
  () => {socket.connected = false;},
  () => {socket.io.engine.writeBuffer.push({});},
  () => {socket.io.engine.transport.writable = false;},
  () => {game.running = false;},
  () => {game.failed = true;},
 ]) {
  game.slot = 0;game.hasSpectators = true;game.spectator = false;
  game.running = true;game.failed = false;socket.connected = true;
  socket.io.engine.writeBuffer.length = 0;socket.io.engine.transport.writable = true;
  block();assert.equal(game.canBroadcast(), false);
  game.broadcast('video', new Uint8Array([1]));assert.equal(sent.length, 1);
 }
 game.failed = false;game.slot = 1;game.coordinator = 1;
 assert.equal(game.canBroadcast(), true, 'capture follows coordinator migration');
});

test('new car state supersedes stale state without dropping reliable events or other racers', () => {
 const {game} = session();
 const packet = (from, value, reliable = false) => ({epoch: 7, from, reliable, payload: new Uint8Array([11, value])});
 game.onEvent(packet(1, 1));game.onEvent(packet(2, 2));
 game.onEvent({epoch: 7, type: 0x101});
 game.onEvent(packet(1, 3, true));game.onEvent(packet(1, 4));
 game.onEvent({...packet(1, 5), epoch: 6});
 assert.equal(game.queue.length, 4);
 assert.deepEqual(Array.from(game.queue.filter(e => e.payload), e => e.payload[1]), [2, 3, 4]);
 game.dispose();assert.equal(game.queue.length, 0);
});

test('missing frame callbacks recover within two 60 Hz frames and cancel their pending callback', async () => {
 const patch = source('ports/cmr2/browser.patch');
 const body = patch.match(/\+EM_ASYNC_JS\(void, Peak_PresentFrame, \(\), \{\n([\s\S]*?)\n\+\}\);/)[1]
  .replace(/^\+/gm, '');
 const timers = new Map(), cancelled = [];
 let now = 100, id = 0;
 const Module = {};
 const context = vm.createContext({Module, performance: {now: () => now},
  setTimeout: (callback, delay) => {timers.set(++id, {callback, at: now + delay});return id;},
  clearTimeout: id => timers.delete(id), requestAnimationFrame: () => 99,
  cancelAnimationFrame: id => cancelled.push(id)});
 const done = vm.runInContext('(async () => {' + body + '})()', context);
 assert.equal(Module.cmr2PresentWaiting, true);
 const fallback = [...timers.values()][0];
 assert(fallback.at - now <= 1000 / 30 + 0.001, 'a withheld callback must not impose a 100 ms frame');
 now = fallback.at;fallback.callback();await done;
 assert.equal(Module.cmr2PresentWaiting, false);
 assert.equal(Module.cmr2FrameFallbacks, 1);
 assert.deepEqual(cancelled, [99]);assert.equal(timers.size, 0);
});
