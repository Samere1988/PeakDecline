"""Link the native runtime and its platform tests without publishing or restarting."""
import argparse
import json
import re
from pathlib import Path
import subprocess
ROOT=Path(__file__).resolve().parents[2]
PORT=Path(__file__).resolve().parent
OUT=ROOT/'.tmp/marioparty-port'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runtime-dir',type=Path,help='Stage the application module here; does not enable the catalog.')
args=parser.parse_args()
runtime_dir=args.runtime_dir.resolve() if args.runtime_dir else OUT
runtime_dir.mkdir(parents=True,exist_ok=True)
runtime_name='marioparty' if args.runtime_dir else 'boot-probe'
factory='createMarioParty' if args.runtime_dir else 'createMarioPartyBootProbe'
subprocess.run([str(ROOT/'.venv/bin/python'),str(PORT/'prepare_renderer.py')],check=True)
renderer_objects=[]
for source in [OUT/'renderer/gfx_pc.c',OUT/'renderer/gfx_cc.c',OUT/'renderer/gfx_opengl.c',OUT/'renderer/mixer.c',PORT/'runtime/renderer.c']:
    obj=OUT/(source.stem+'.o')
    subprocess.run([str(ROOT/'.tmp/emsdk/upstream/emscripten/emcc'),'-O2','-D_LANGUAGE_C','-DF3DEX_GBI_2','-DRAPI_GL','-DUSE_GLES','-I',str(ROOT/'.tmp/sm64ex/include'),'-I',str(OUT/'renderer'),'-I',str(PORT/'runtime'),'-c',str(source),'-o',str(obj)],check=True)
    renderer_objects.append(str(obj))
report=json.loads((OUT/'core-report.json').read_text())
# Missing platform functions throw by name. None pretend to provide game behavior.
os_object=OUT/'os.o'
process_object=OUT/'process.o'
subprocess.run([str(ROOT/'.tmp/emsdk/upstream/emscripten/emcc'),'-O1','-Wall','-Wextra','-I',str(ROOT/'.tmp/marioparty-recompiler/include'),'-c',str(PORT/'runtime/process.c'),'-o',str(process_object)],check=True)
subprocess.run([str(ROOT/'.tmp/emsdk/upstream/emscripten/emcc'),'-O1','-Wall','-Wextra','-I',str(ROOT/'.tmp/marioparty-recompiler/include'),'-c',str(PORT/'runtime/os.c'),'-o',str(os_object)],check=True)
symbols=subprocess.check_output([str(ROOT/'.tmp/emsdk/upstream/bin/llvm-nm'),'--format=posix',str(OUT/'marioparty-core.a'),str(os_object),str(process_object)],text=True)
defined={line.split()[0] for line in symbols.splitlines() if len(line.split())>1 and line.split()[1] in ('T','W')}
table=set(re.findall(r'\.func = (\w+)',(OUT/'all-generated/recomp_overlays.inl').read_text()))
names=sorted(({n for n in report['unresolved'] if n.endswith('_recomp')} | table)-defined)
traps=OUT/'missing-platform.c'
traps.write_text('#include "recomp.h"\n#include <emscripten/emscripten.h>\n'+''.join(
 'void '+n+'(uint8_t *rdram,recomp_context *ctx){(void)rdram;(void)ctx;EM_ASM({throw new Error("Unimplemented Mario Party platform service: '+n+'");});}\n' for n in names))
subprocess.run([str(ROOT/'.tmp/emsdk/upstream/emscripten/emcc'),'-O1','-I',str(ROOT/'.tmp/marioparty-recompiler/include'),'-I',str(OUT/'all-generated'),'-I',str(PORT/'runtime'),str(PORT/'runtime/boot_probe.c'),str(traps),str(os_object),str(process_object),*renderer_objects,str(OUT/'marioparty-core.a'),'--emit-symbol-map','-sASYNCIFY=1','-sMODULARIZE=1','-sEXPORT_NAME='+factory,'-sINITIAL_MEMORY=134217728','-sEXPORTED_RUNTIME_METHODS=FS','-sEXPORTED_FUNCTIONS=_mp_hash,_mp_render_test,_mp_word,_mp_pad,_mp_audio_tasks,_mp_rendered_frames,_mp_prepare,_mp_tick,_mp_boot,_mp_boot_threads,_mp_load_section,_mp_lookup_section','-o',str(runtime_dir/(runtime_name+'.js'))],check=True)
print('Built '+str(runtime_dir/(runtime_name+'.js'))+'. Unsupported platform services remain explicit errors.')

# Small independent behavioral tests use the same hosted OS implementation.
subprocess.run([str(ROOT/'.tmp/emsdk/upstream/emscripten/emcc'),'-O1','-Wall','-Wextra','-I',str(ROOT/'.tmp/marioparty-recompiler/include'),str(PORT/'runtime/os.c'),str(PORT/'runtime/os_test.c'),str(PORT/'runtime/process.c'),str(PORT/'runtime/process_test.c'),'-sASYNCIFY=1','-sMODULARIZE=1','-sEXPORT_NAME=createMarioPartyOSTest','-sINITIAL_MEMORY=67108864','-sEXPORTED_FUNCTIONS=_mp_test_os,_mp_test_result,_mp_test_process,_mp_test_process_result','-o',str(OUT/'os-test.js')],check=True)
subprocess.run([str(ROOT/'.tmp/emsdk/upstream/emscripten/emcc'),'-O2','-D_LANGUAGE_C','-I',str(ROOT/'.tmp/sm64ex/include'),str(OUT/'renderer/mixer.c'),str(PORT/'runtime/audio_test.c'),'-sMODULARIZE=1','-sEXPORTED_FUNCTIONS=_mp_test_audio','-o',str(OUT/'audio-test.js')],check=True)
