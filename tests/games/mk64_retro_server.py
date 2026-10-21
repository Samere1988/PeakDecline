"""Local MK64 integration fixture with disposable accounts/saves and a candidate build."""
import argparse
from dataclasses import replace
from pathlib import Path
import tempfile

from retro_test import ROOT, GAMES, make_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8068)
    parser.add_argument('--build-dir', type=Path, default=ROOT / '.tmp/mk64/candidate-netplay')
    parser.add_argument('--authority-diagnostics', action='store_true')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Choose an unprivileged local port.')
    build = args.build_dir.resolve()
    if not all((build / filename).is_file() for filename in ('mk64.js', 'mk64.wasm')):
        parser.error(f'Missing MK64 candidate build: {build}')
    GAMES['mk64'] = replace(GAMES['mk64'], build_dir=str(build))
    with tempfile.TemporaryDirectory(prefix='mk64-retro-test-') as directory:
        instance = Path(directory)
        (instance / 'netplay').mkdir()
        (instance / 'netplay/build').symlink_to(ROOT / 'instance/netplay/build', target_is_directory=True)
        app, socket = make_app(instance)
        if args.authority_diagnostics:
            @app.after_request
            def authority_diagnostics(response):
                if response.mimetype == 'text/html' and '<body' in response.get_data(as_text=True):
                    script = (ROOT / 'tests/games/mk64_authority_fixture.js').read_text()
                    response.set_data(response.get_data(as_text=True).replace('</body>', '<script>'+script+'</script></body>'))
                return response
        socket.run(app, host='127.0.0.1', port=args.port, debug=False, allow_unsafe_werkzeug=True)


if __name__ == '__main__':
    main()
