"""Build the Mario Party 2 native browser diagnostic; never publish/restart.

A successful build alone does not certify gameplay or enable the catalog.
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
    parser.add_argument('--rom',type=Path,default=ROOT/'static/roms/N64/Mario Party 2 (U) [!].z64')
    args=parser.parse_args()
    if hashlib.sha1(args.rom.read_bytes()).hexdigest()!=SPEC['rom_sha1']:raise SystemExit('Wrong ROM: original US .z64 required.')
    source=checkout('decomp','marioparty2-native')
    recomp=checkout('recompiler','marioparty-recompiler')
    checkout('renderer','sm64ex')
    run('git','submodule','update','--init','--recursive',cwd=recomp)
    python=ROOT/'.tmp/marioparty2-tools/bin/python'
    if not python.exists():run(sys.executable,'-m','venv',python.parents[1])
    run(python,'-m','pip','install','splat64[mips] @ git+'+SPEC['splat']['repository']+'@'+SPEC['splat']['commit'],'spimdisasm==1.40.0')
    shutil.copyfile(args.rom,source/'baserom.us.z64')
    run(python,'-m','splat','split','marioparty2.yaml','--disassemble-all',cwd=source)
    cmake=ROOT/'.venv/bin/cmake'
    run(cmake,'-S',recomp,'-B',recomp/'build','-G','Ninja','-DCMAKE_MAKE_PROGRAM='+str(ROOT/'.venv/bin/ninja'),'-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_C_COMPILER='+shutil.which('gcc',path=ENV['PATH']),'-DCMAKE_CXX_COMPILER='+shutil.which('g++',path=ENV['PATH']))
    run(cmake,'--build',recomp/'build','--target','N64Recomp','-j6')
    run(python,PORT/'prepare.py')
    out=ROOT/'.tmp/marioparty2-port'
    run(recomp/'build/N64Recomp',out/'all.toml')
    run(sys.executable,PORT/'compile_core.py')
    run(sys.executable,PORT/'build_boot_probe.py')

if __name__=='__main__':main()
