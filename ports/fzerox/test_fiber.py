"""Build and run the real browser fiber backend under the Emscripten runtime."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / '.tmp/fzerox/tests'
BUILD.mkdir(parents=True, exist_ok=True)
subprocess.run([
    sys.executable, str(ROOT / '.tmp/mk64/emsdk/upstream/emscripten/emcc.py'),
    str(ROOT / 'ports/fzerox/src/web_fiber.c'), str(ROOT / 'tests/games/fzerox_fiber.c'),
    '-I' + str(ROOT / '.tmp/fzerox/G-Diffuser/port'), '-sASYNCIFY=1',
    '-sENVIRONMENT=node', '-sASSERTIONS=2', '-sSTACK_OVERFLOW_CHECK=2',
    '-O1', '-o', str(BUILD / 'fiber-test.js')], check=True)
subprocess.run(['node', str(BUILD / 'fiber-test.js')], check=True)
subprocess.run([
    sys.executable, str(ROOT / '.tmp/mk64/emsdk/upstream/emscripten/emcc.py'),
    str(ROOT / 'ports/fzerox/src/web_fiber.c'), str(ROOT / 'tests/games/fzerox_fiber.c'),
    '-I' + str(ROOT / '.tmp/fzerox/G-Diffuser/port'), '-sASYNCIFY=1',
    '-pthread', '-sPTHREAD_POOL_SIZE=1', '-DTEST_MAIN_LOOP=1', '-sEXIT_RUNTIME=1',
    '-sENVIRONMENT=node', '-sASSERTIONS=2', '-sSTACK_OVERFLOW_CHECK=2',
    '-O1', '-o', str(BUILD / 'fiber-loop-test.js')], check=True)
subprocess.run(['node', str(BUILD / 'fiber-loop-test.js')], check=True, timeout=30)
