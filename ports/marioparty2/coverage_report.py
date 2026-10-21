"""Summarize isolated release-module tests; never marks incomplete cases passed."""
import argparse
import hashlib
import html
import json
from pathlib import Path

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--rendered',type=Path,default=Path('.tmp/mp2-coverage-rendered'))
parser.add_argument('--sync',type=Path,default=Path('.tmp/mp2-coverage-sync'))
parser.add_argument('--output',type=Path,default=Path('.tmp/mp2-coverage-report'))
parser.add_argument('--build-dir',type=Path,default=Path('.tmp/marioparty2-port/release'))
parser.add_argument('--natural',type=Path,default=Path('.tmp/mp2-coverage-natural'))
parser.add_argument('--board-captures',type=Path,default=Path('.tmp/mp2-board-captures'))
args=parser.parse_args()
args.output.mkdir(parents=True,exist_ok=True)
cases=json.loads(Path('ports/marioparty2/coverage_cases.json').read_text())
findings=json.loads(Path('ports/marioparty2/coverage_findings.json').read_text())
runtime_sha256=hashlib.sha256((args.build_dir/'marioparty2.wasm').read_bytes()).hexdigest()
rows=[]
for case in cases:
    path=args.rendered/(case['key']+'.json')
    row=dict(case=case,status='PENDING',sync='PENDING')
    if path.exists():
        result=json.loads(path.read_text())
        assert result.get('runtime_sha256')==runtime_sha256, f'Stale or unpinned runtime report: {path}'
        row.update(status=result['status'],ticks=result.get('ticks'),error=result.get('error'),entered=result.get('entered'),exited=result.get('exited'))
        other=args.sync/path.name
        if other.exists():
            replay=json.loads(other.read_text())
            assert replay.get('runtime_sha256')==runtime_sha256, f'Stale or unpinned replay: {other}'
            same=all(result.get(k)==replay.get(k) for k in ['hashes','finalHash','stages','ticks','status'])
            left=dict(result.get('hashes',[]));right=dict(replay.get('hashes',[]))
            shared=set(left)&set(right)
            if any(left[k]!=right[k] for k in shared):row['sync']='MISMATCH'
            elif same:row['sync']='MATCH' if result['status']=='PASS' else 'MATCH_TO_STOP'
            else:row['sync']='INCOMPLETE' if shared else 'UNVERIFIED'
    natural=args.natural/(case['key']+'.json')
    if case['kind']=='board':
        row['normal_menu']='NOT_RUN'
        if natural.exists():
            normal=json.loads(natural.read_text())
            assert normal.get('runtime_sha256')==runtime_sha256, f'Stale normal-menu report: {natural}'
            row['normal_menu']=normal['status']
    row['runtime_status']=row['status']
    if case['key'] in findings and row['status']!='PENDING':
        finding=findings[case['key']]
        row['note']=finding['note']
        # A known visual issue must never conceal a new crash or incomplete run.
        if row['status']=='PASS':row['status']=finding['status']
    rows.append(row)
summary={s:sum(r['status']==s for r in rows) for s in sorted({r['status'] for r in rows})}
report=dict(summary=summary,sources=json.loads(Path('ports/marioparty2/sources.json').read_text()),runtime_sha256=hashlib.sha256((args.build_dir/'marioparty2.wasm').read_bytes()).hexdigest(),rows=rows)
(args.output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
lines=['# Mario Party 2 board and minigame coverage','',
'Isolated Chromium tests of the release Wasm. The live service and production assets are not changed.',
'', 'Results: '+', '.join(f'{n} {status}' for status,n in summary.items())+'.',
'',
'Board cases set the board index during normal setup and advance into play. Minigame cases set the chosen minigame at the normal instructions transition, configure CPU players and the cartridge category’s team grouping, then execute original code. Gameplay frames render continuously after the target is entered. The independent replay skips most presentation and compares guest-state hashes every 600 ticks plus the final state. These are targeted regression checks, not complete campaigns or exhaustive human-controller testing.',
'',
'PASS means the target ran, produced audio, and exited (minigames), or reached the next board turn (boards), without a runtime/WebGL error. INCOMPLETE means the frame budget expired before completion; it does not establish a game bug. Fixture-only failures require reproduction through normal menu inputs. MATCH checks deterministic execution and presentation independence; actual network transport has separate lobby tests.',
'',
'| Case | Result | Independent replay | Ticks |','|---|---|---|---|']
for r in rows:
    lines.append(f"| {r['case'].get('title',r['case']['key'])} | {r['status']} | {r['sync']} | {r.get('ticks','')} |")
lines+=['','## Normal-menu board cross-checks','']+[f"- {r['case']['title']}: {r['normal_menu']}" for r in rows if r['case']['kind']=='board']
lines+=['','## Findings','']+[f"- **{key}:** {value['note']}" for key,value in findings.items()]
(args.output/'report.md').write_text('\n'.join(lines)+'\n')
cards=[]
for row in rows:
    key=row['case']['key']
    images=sorted(args.rendered.glob(key+'-*.png'))
    if row['case']['kind']=='board':
        gameplay=args.board_captures/(key+'.png')
        images=([gameplay] if gameplay.exists() else list(args.rendered.glob(key+'.png')))+images
    if not images: images=list(args.rendered.glob(key+'.png'))
    cards.append('<article><h3>'+html.escape(row['case'].get('title',key))+'</h3><p>'+row['status']+' / '+row['sync']+'</p>'+''.join('<img src="'+p.resolve().as_uri()+'">' for p in images[:2])+'</article>')
(args.output/'gallery.html').write_text('<!doctype html><meta charset="utf-8"><title>Mario Party 2 coverage</title><style>body{background:#151923;color:#eee;font:14px sans-serif}main{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}article{background:#252c3b;padding:10px}h3{font-size:14px}img{width:49%;image-rendering:pixelated}</style><h1>Mario Party 2 gameplay captures</h1><main>'+''.join(cards)+'</main>')
print(json.dumps(dict(summary=summary,sync={s:sum(r['sync']==s for r in rows) for s in sorted({r['sync'] for r in rows})})))
