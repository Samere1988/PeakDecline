"""Compile all translated functions to a Wasm archive; this is not a runtime."""
from concurrent.futures import ThreadPoolExecutor
import json
import re
from pathlib import Path
import subprocess
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'.tmp/marioparty-port'
SDK=ROOT/'.tmp/emsdk/upstream'

def main():
    sources=sorted((OUT/'all-generated').glob('funcs_*.c')) + [ROOT/'ports/marioparty/runtime/platform.c']
    if not sources:raise SystemExit('Run build.py --audit-all first.')
    declarations=(OUT/'all-generated/funcs.h').read_text()
    calls=set()
    for source in sources:
        calls.update(re.findall(r'\b(\w+)\(rdram, ctx\)',source.read_text()))
    imports=sorted(name for name in calls if not re.search(r'\b'+re.escape(name)+r'\s*\(',declarations))
    header=OUT/'platform-imports.h'
    header.write_text('#include "recomp.h"\n'+''.join('void '+name+'(uint8_t*, recomp_context*);\n' for name in imports))
    objects=OUT/'objects';objects.mkdir(exist_ok=True)
    def compile(source):
        target=objects/(source.stem+'.o')
        subprocess.run([str(SDK/'emscripten/emcc'),'-O2','-Wno-incompatible-library-redeclaration','-I',str(ROOT/'.tmp/marioparty-recompiler/include'),'-include',str(header),'-c',str(source),'-o',str(target)],check=True)
        return target
    with ThreadPoolExecutor(max_workers=6) as pool:built=list(pool.map(compile,sources))
    archive=OUT/'marioparty-core.a'
    if archive.exists():archive.unlink()
    subprocess.run([str(SDK/'bin/llvm-ar'),'rcs',str(archive),*map(str,built)],check=True)
    symbols=subprocess.check_output([str(SDK/'bin/llvm-nm'),'--format=posix',str(archive)],text=True)
    defined=set();undefined=set()
    for line in symbols.splitlines():
        fields=line.split()
        if len(fields)<2:continue
        if fields[1]=='U':undefined.add(fields[0])
        elif fields[1] in ('T','W','D','B','R'):defined.add(fields[0])
    report=dict(translation_units=len(built),defined_symbols=len(defined),unresolved=sorted(undefined-defined),playable=False)
    (OUT/'core-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))

if __name__=='__main__':main()
