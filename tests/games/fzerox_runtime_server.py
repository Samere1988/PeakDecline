"""Local-only browser runtime fixture; no production app or databases."""
from pathlib import Path
from flask import Flask, send_from_directory, send_file

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / '.tmp/fzerox/runtime-build'
app = Flask(__name__, static_folder=None)


@app.after_request
def isolation(response):
    response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    response.headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.get('/')
def index():
    return '''<!doctype html><meta charset="utf-8"><title>F-Zero renderer test</title>
<canvas id="canvas" width="640" height="480"></canvas><pre id="status">Loading renderer</pre>
<script>
window.Module = {canvas: document.getElementById('canvas'),
    print: text => console.log(text), printErr: text => console.error(text),
    onAbort: text => document.getElementById('status').textContent = 'Aborted: ' + text};
</script><script src="/renderer_probe.js"></script>'''


@app.get('/<name>')
def asset(name):
    if name not in ('renderer_probe.js', 'renderer_probe.wasm', 'renderer_probe.data', 'fzerox.js', 'fzerox.wasm', 'fzerox.data'):
        return 'Not found', 404
    return send_from_directory(BUILD, name)


@app.get('/game.z64')
def rom():
    return send_file(ROOT / 'static/roms/N64/F-ZERO X (U) [!].z64')


@app.get('/game')
def game():
    return '''<!doctype html><meta charset="utf-8"><title>F-Zero game test</title>
<canvas id="canvas" width="640" height="480"></canvas><pre id="status">Loading game</pre>
<script>
window.Module = {canvas: document.getElementById('canvas'), noInitialRun: true,
    print: text => console.log(text), printErr: text => console.error(text),
    onRuntimeInitialized: async () => {
        const response = await fetch('/game.z64');
        Module.FS.writeFile('/game.z64', new Uint8Array(await response.arrayBuffer()));
        Module.callMain([]);
    },
    onAbort: text => document.getElementById('status').textContent = 'Aborted: ' + text};
</script><script src="/fzerox.js"></script>'''


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8067, threaded=True)
