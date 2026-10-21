/* Native Diablo packets use authenticated seats; spectators receive media only. */
(() => {
 'use strict';
 class DiabloSession {
  static async create(options) { return new DiabloSession(options); }
  constructor(options) {
   Object.assign(this, options); this.queue = []; this.running = false; this.failed = false; this.frame = 0;
   this.onPacket = event => {
    if (event.epoch !== this.epoch || this.spectator || this.failed) return;
    if (this.queue.length >= 2048) return this.fail('Diablo is not keeping up with the room.');
    this.queue.push(new Uint8Array(event.packet)); this.packetCount = (this.packetCount || 0) + 1;
   };
   this.onMedia = event => {
    if (this.running && this.spectator && event.epoch === this.epoch) {
     this.socket.emit('diablo_media_ack', {epoch:this.epoch, sequence:event.sequence});
     this.media?.(event);
    }
   };
   this.hasSpectators = false;
   this.onRoom = event => {
    if(event.epoch === this.epoch && event.game?.id === this.game.id)
     this.hasSpectators = event.members.some(member => member.role === 'spectator');
   };
   this.socket.on('room_update', this.onRoom); this.socket.on('start', this.onRoom);
   this.socket.on('diablo_packet', this.onPacket); this.socket.on('diablo_media', this.onMedia);
  }
  bind(launch, media) {
   this.launch = launch; this.media = media;
   this.socket.emit('loaded', {epoch:this.epoch, compatibility:this.game});
  }
  start() { if (this.running || this.failed) return; this.running = true; this.launch?.(); }
  send(packet) {
   if (this.running && !this.spectator && !this.failed) this.socket.emit('diablo_packet', {epoch:this.epoch, packet});
  }
  broadcast(kind, payload) {
   if (this.running && this.slot === 0 && this.hasSpectators && !this.failed && this.socket.connected)
    if ((this.socket.io?.engine?.writeBuffer?.length || 0) < 4)
     this.socket.emit('diablo_media', {epoch:this.epoch, kind, payload:new Uint8Array(payload)});
  }
  fail(message) {
   if(this.failed)return;
   this.socket.emit('failed', {epoch:this.epoch, message});
   this.failed = true; this.onFailure(message);
  }
  latency() {}
  dispose() {
   this.running = false; this.failed = true; this.queue.length = 0;
   this.socket.off('room_update', this.onRoom); this.socket.off('start', this.onRoom);
   this.socket.off('diablo_packet', this.onPacket); this.socket.off('diablo_media', this.onMedia);
   this.launch = this.media = null;
  }
 }
 PeakNet.backends.set('devilution-native-v1', DiabloSession);
})();
