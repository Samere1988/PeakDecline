"""Local-only browser port harness. Never deploy this development server."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import re

ROOT = Path(__file__).resolve().parents[2]


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        paths = {
            '/': ROOT / 'ports/mk64/harness.html',
            '/mk64.js': self.server.build_dir / 'mk64.js',
            '/mk64.wasm': self.server.build_dir / 'mk64.wasm',
            '/baserom.us.z64': self.server.rom,
        }
        path = paths.get(self.path.split('?')[0])
        relative = self.path.split('?')[0]
        match = re.fullmatch(r'/static/mk64-hd/([a-z0-9.-]+)/(textures/[0-9a-f]{32}\.webp|manifest\.json|credits\.txt)', relative)
        if match:
            path = ROOT / 'static/mk64-hd' / match[1] / match[2]
        if path is None or not path.is_file():
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/wasm' if path.suffix == '.wasm' else self.guess_type(str(path)))
        self.send_header('Content-Length', str(path.stat().st_size))
        self.end_headers()
        with path.open('rb') as source:
            self.copyfile(source, self.wfile)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--rom', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8064)
    parser.add_argument('--build-dir', type=Path, default=ROOT / 'instance/mk64/build')
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.rom = args.rom.resolve(strict=True)
    server.build_dir = args.build_dir.resolve(strict=True)
    print(f'Local MK64 harness: http://127.0.0.1:{args.port}', flush=True)
    server.serve_forever()
