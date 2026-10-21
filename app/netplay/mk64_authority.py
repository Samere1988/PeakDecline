"""Bounded room-owned native simulation process. No browser may publish state."""
import json
from pathlib import Path
import queue
import shutil
import struct
from time import monotonic
import subprocess

BACKEND = 'mk64-server-authority-v1'
ROOT = Path(__file__).resolve().parents[2]


class Worker:
    def __init__(self, app, socketio, game, players, epoch, initial, callback):
        self.closed = False
        self.closing = False
        self.active = False
        self.last_message = monotonic()
        self.process = None
        self.gate = None
        self.commands = queue.Queue(maxsize=256)
        self.callback = callback
        self.socketio = socketio
        self.config = dict(type='init', build=str(Path(app.instance_path) / game.build_dir),
                           rom=str(Path(app.static_folder) / game.rom), players=players, epoch=epoch,
                           save=initial.get('files', {}).get('eeprom.bin'))
        self.node = app.config.get('MK64_NODE') or shutil.which('node')
        self.subprocess = subprocess
        if socketio.async_mode == 'gevent':
            from gevent import subprocess as green_subprocess
            from gevent.queue import Queue
            self.subprocess = green_subprocess
            self.commands = Queue(maxsize=256)

    def launch(self):
        if self.closed:
            return
        acquired = False
        try:
            if self.gate is not None:
                acquired = self.gate.acquire(timeout=5)
                if not acquired:
                    raise RuntimeError('Mario Kart worker capacity exhausted')
                if self.closed:
                    return
            if not self.node:
                raise RuntimeError('Node.js is required for the Mario Kart authority')
            self.process = self.subprocess.Popen(
                [self.node, '--max-old-space-size=192', str(ROOT / 'ports/mk64/authority_worker.cjs')],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
                cwd=str(ROOT), start_new_session=True)
            if self.closed:
                self.process.terminate()
                return
            self.send(self.config)
            self.socketio.start_background_task(self._write)
            self.socketio.start_background_task(self._watch)
            while not self.closed:
                size = struct.unpack('<I', self._read(4))[0]
                if not 4 <= size <= 16 * 1024 * 1024:
                    raise ValueError('Invalid authority envelope')
                packet = self._read(size)
                length = struct.unpack('<I', packet[:4])[0]
                if not 0 < length <= min(8192, size-4):
                    raise ValueError('Invalid authority metadata')
                meta = json.loads(packet[4:4+length])
                self.last_message = monotonic()
                self.callback(meta, packet[4+length:])
        except Exception:
            if not self.closed and not self.closing:
                self.callback(dict(type='failure'), b'')
        finally:
            self.closed = True
            try:
                self.commands.put_nowait(None)
            except Exception:
                pass
            if self.process:
                try:
                    self.process.wait(timeout=2)
                except self.subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
                for stream in (self.process.stdin, self.process.stdout):
                    stream.close()
            if acquired:
                self.gate.release()

    def _read(self, size):
        parts = bytearray()
        while len(parts) < size:
            chunk = self.process.stdout.read(size-len(parts))
            if not chunk:
                raise EOFError('Authority exited')
            parts.extend(chunk)
        return bytes(parts)

    def _write(self):
        try:
            while not self.closed:
                message = self.commands.get()
                if message is None:
                    return
                payload = (json.dumps(message, separators=(',', ':'))+'\n').encode()
                # Unbuffered pipe writes may be partial.
                while payload:
                    count = self.process.stdin.write(payload)
                    if not count:
                        return
                    payload = payload[count:]
        except (OSError, ValueError):
            pass  # Reader owns failure notification and cleanup.

    def _watch(self):
        while not self.closed:
            self.socketio.sleep(1)
            if self.active and monotonic()-self.last_message > 10:
                self.callback(dict(type='failure'), b'')
                self.close()
                return

    def send(self, message):
        if self.closed:
            return False
        if message.get('type') == 'start':
            self.active = True
            self.last_message = monotonic()
        try:
            self.commands.put_nowait(message)
            return True
        except Exception as error:
            if error.__class__.__name__ == 'Full':
                return False
            raise

    def close(self):
        if self.closed or self.closing:
            return
        self.closing = True
        self.active = False
        if self.process and self.process.poll() is None:
            self.send(dict(type='stop'))
            self.socketio.start_background_task(self._terminate_later)
            return
        self.closed = True
        try:
            self.commands.put_nowait(None)
        except Exception:
            pass
        if self.process and self.process.poll() is None:
            self.process.terminate()

    def _terminate_later(self):
        self.socketio.sleep(2)
        if self.process and self.process.poll() is None:
            self.process.terminate()
