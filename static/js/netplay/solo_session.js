/* A single local player publishes bounded presentation media to spectators. */
(() => {
 'use strict';
 class SoloSession {
  static async create(options) { return new SoloSession(options); }
  constructor(options) {
   Object.assign(this, options); this.queue = []; this.running = false; this.failed = false; this.frame = 0;
   this.onMedia = event => {
    if (this.running && this.spectator && event.epoch === this.epoch) {
     this.socket.emit('solo_media_ack', {epoch:this.epoch, sequence:event.sequence});
     this.media?.(event);
    }
   };
   this.hasSpectators = false;
   this.onRoom = event => {
    if(event.epoch === this.epoch && event.game?.id === this.game.id)
     this.hasSpectators = event.members.some(member => member.role === 'spectator');
   };
   this.socket.on('room_update', this.onRoom); this.socket.on('start', this.onRoom);
   this.socket.on('solo_media', this.onMedia);
  }
  bind(launch, media) {
   this.launch = launch; this.media = media;
   this.socket.emit('loaded', {epoch:this.epoch, compatibility:this.game});
  }
  start() { if (this.running || this.failed) return; this.running = true; this.launch?.(); }
  broadcast(kind, payload) {
   if (this.running && this.slot === 0 && this.hasSpectators && !this.failed && this.socket.connected)
    if ((this.socket.io?.engine?.writeBuffer?.length || 0) < 4)
     this.socket.emit('solo_media', {epoch:this.epoch, kind, payload:new Uint8Array(payload)});
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
   this.socket.off('solo_media', this.onMedia);
   this.launch = this.media = null;
  }
 }
 PeakNet.backends.set('solo-media-v1', SoloSession);
})();
