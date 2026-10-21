"""Build and verify the native WebAssembly translation probe; never publish/restart.

Full-game translation is a separate diagnostic (--audit-all), not a playable build.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
PORT=Path(__file__).resolve().parent
SPEC=json.loads((PORT/'sources.json').read_text())
ENV=os.environ.copy()
LOCAL=ROOT/'.tmp/native-tools'
ENV['PATH']=str(LOCAL/'bin')+os.pathsep+ENV['PATH']
if (LOCAL/'root/usr/lib/x86_64-linux-gnu').exists():
    ENV['LD_LIBRARY_PATH']=str(LOCAL/'root/usr/lib/x86_64-linux-gnu')+os.pathsep+ENV.get('LD_LIBRARY_PATH','')

def run(*args,cwd=ROOT):
    subprocess.run([str(a) for a in args],cwd=cwd,env=ENV,check=True)

def checkout(key,name):
    folder=ROOT/'.tmp'/name
    if not folder.exists():
        run('git','clone','--no-checkout',SPEC[key]['repository'],folder)
        run('git','checkout','--detach',SPEC[key]['commit'],cwd=folder)
    actual=subprocess.check_output(['git','rev-parse','HEAD'],cwd=folder,text=True).strip()
    if actual!=SPEC[key]['commit']:raise SystemExit('Unexpected source revision: '+str(folder))
    return folder

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rom',type=Path,default=ROOT/'static/roms/N64/Mario Party (U) [!].z64')
    parser.add_argument('--audit-all',action='store_true')
    args=parser.parse_args()
    if hashlib.sha1(args.rom.read_bytes()).hexdigest()!=SPEC['rom_sha1']:raise SystemExit('Wrong ROM: original US .z64 required.')
    source=checkout('decomp','marioparty-native')
    recomp=checkout('recompiler','marioparty-recompiler')
    checkout('renderer','sm64ex')
    run('git','submodule','update','--init','--recursive',cwd=recomp)
    python=ROOT/'.tmp/marioparty-tools/bin/python'
    if not python.exists():run(sys.executable,'-m','venv',python.parents[1])
    run(python,'-m','pip','install','-r',source/'requirements.txt')
    shutil.copyfile(args.rom,source/'baserom.us.z64')
    run(python,'-m','splat','split','marioparty.yaml','--disassemble-all',cwd=source)
    cmake=ROOT/'.venv/bin/cmake'
    run(cmake,'-S',recomp,'-B',recomp/'build','-G','Ninja','-DCMAKE_MAKE_PROGRAM='+str(ROOT/'.venv/bin/ninja'),'-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_C_COMPILER='+shutil.which('gcc',path=ENV['PATH']),'-DCMAKE_CXX_COMPILER='+shutil.which('g++',path=ENV['PATH']))
    run(cmake,'--build',recomp/'build','--target','N64Recomp','-j6')
    run(python,PORT/'prepare.py')
    out=ROOT/'.tmp/marioparty-port'
    run(recomp/'build/N64Recomp',out/'probe.toml')
    run(ROOT/'.tmp/emsdk/upstream/emscripten/emcc','-O2','-I',recomp/'include','-I',out/'probe-generated',PORT/'probe.c',*sorted((out/'probe-generated').glob('*.c')),
        '-sMODULARIZE=1','-sEXPORT_NAME=createMarioPartyProbe','-sEXPORTED_FUNCTIONS=_seed,_next_random','-sENVIRONMENT=web,node','-o',out/'probe.js')
    run(ROOT/'.tmp/emsdk/node/24.19.0_64bit/bin/node',PORT/'probe_test.cjs')
    if args.audit_all:run(recomp/'build/N64Recomp',out/'all.toml')

if __name__=='__main__':main()
