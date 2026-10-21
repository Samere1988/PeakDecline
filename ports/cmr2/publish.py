"""Publish an accepted CMR2 candidate without restarting the live service."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import uuid
from build import ROOT, WORK


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build',type=Path,default=WORK/'browser-build/game')
    parser.add_argument('--data',type=Path,default=WORK/'data')
    parser.add_argument('--build-only',action='store_true',help='Replace the build while retaining an identical installed asset manifest.')
    args=parser.parse_args()
    build=args.build.resolve();data=args.data.resolve()
    record=json.loads((build/'verified.json').read_text())
    required=('opencmr2.js','opencmr2.wasm','assets.json','sources.json','LICENSE')
    if record.get('passed') is not True or any(hashlib.sha256((build/name).read_bytes()).hexdigest()!=record.get('sha256',{}).get(name) for name in required):
        raise SystemExit('The candidate must pass browser acceptance after its last build.')
    rendering=json.loads((build/'render-verified.json').read_text())
    if rendering.get('passed') is not True or any(rendering.get('sha256',{}).get(name)!=record['sha256'][name] for name in ('opencmr2.js','opencmr2.wasm')):
        raise SystemExit('Browser rendering acceptance must match this build.')
    firefox_checks=[result for result in rendering.get('results',[]) if result.get('engine')=='firefox']
    if not firefox_checks or any(result['fps']<30 or result['p95Ms']>=50 or result.get('sceneColors',0)<128 for result in firefox_checks):
        raise SystemExit('Verify textured Firefox race rendering, 30 FPS, and frame pacing before publication.')
    if any(result['fps']<50 or result.get('delayedMaps',0)<1 or result.get('p99Ms',float('inf'))>=50
           or result.get('over100',1)!=0 for result in firefox_checks):
        raise SystemExit('Verify native frame pacing with delayed GPU readbacks before publication.')
    for result in firefox_checks:
        memory=result.get('gpuMemory',{})
        start,end=memory.get('start',{}),memory.get('end',{})
        if (result.get('soakSeconds',0)<180 or result.get('bindGroupsPerFrame',float('inf'))>=10 or end.get('destroyed',0)<=start.get('destroyed',0)+100
            or end.get('liveBytes',float('inf'))>=start.get('liveBytes',0)+16*1024*1024):
            raise SystemExit('Verify three minutes of racing with reused bindings, GPU cleanup and bounded buffer memory before publication.')
    stage=ROOT/'instance'/('.cmr2-publish-'+uuid.uuid4().hex)
    destination=ROOT/'instance/cmr2'
    stage.mkdir(parents=True)
    try:
        (stage/'build').mkdir();(stage/'data').mkdir()
        for name in (*required,'verified.json','render-verified.json'):shutil.copy2(build/name,stage/'build'/name)
        if args.build_only:
            if not (destination/'data/installed.json').is_file() or (destination/'build/assets.json').read_bytes()!=(build/'assets.json').read_bytes():
                raise SystemExit('Build-only publication requires the same installed assets.')
            backup=destination/('build-backup-'+uuid.uuid4().hex)
            (destination/'build').rename(backup)
            try:(stage/'build').rename(destination/'build')
            except BaseException:
                backup.rename(destination/'build')
                raise
            print('Published renderer:',destination/'build','(service not restarted)')
            return
        manifest=json.loads((build/'assets.json').read_text())
        for entry in manifest['files']:
            relative=Path(entry['path'])
            if relative.is_absolute() or '..' in relative.parts:raise ValueError('Invalid asset path.')
            source=data/relative
            if source.stat().st_size!=entry['size'] or hashlib.sha256(source.read_bytes()).hexdigest()!=entry['sha256']:
                raise ValueError('Asset changed: '+str(relative))
            output=stage/'data'/relative;output.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,output)
        (stage/'data/installed.json').write_text('{"installed":true}\n')
        if destination.exists():destination.rename(destination.with_name('cmr2-backup-'+uuid.uuid4().hex))
        stage.rename(destination)
        print('Published:',destination,'(service not restarted)')
    finally:
        if stage.exists():shutil.rmtree(stage)


if __name__=='__main__':main()
