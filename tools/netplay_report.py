"""Summarize NETPLAY journal records from stdin. No production database access."""
import argparse
from collections import Counter
import json
import sys


def summarize(lines, room_filter=None):
    groups={}
    for line in lines:
        if 'NETPLAY ' not in line:
            continue
        try:
            row=json.loads(line.split('NETPLAY ',1)[1])
            if not isinstance(row,dict) or not all(k in row for k in ('room','name','game','epoch','event')):
                continue
            if room_filter and room_filter.casefold() not in (row['room'].casefold(),row['name'].casefold()):
                continue
            key=(row['room'],row['game'],row['epoch'])
            group=groups.setdefault(key,dict(room=row['room'],name=row['name'],game=row['game'],epoch=row['epoch'],events=Counter(),peers={}))
            if row['event']!='sample':
                group['events'][row['event']]+=1
                continue
            peer=group['peers'].setdefault(row['peer'],dict(role=row['role'],slot=row['slot'],samples=0,
                normalWindows=0,normalMs=0,normalFrames=0,minFps=None,noProgressMs=0,
                hiddenMs=0,catchupMs=0,rttSum=0,rttCount=0,maxRttMs=None,probeTimeouts=0))
            peer['samples']+=1
            for field in ('hiddenMs','catchupMs','probeTimeouts'):peer[field]+=row[field]
            if isinstance(row.get('render'),dict):
                render=row['render']
                timing=peer.setdefault('render',dict(samples=0,over50=0,over100=0,worstWindowP99Ms=0,worstFrame=None))
                for field in ('samples','over50','over100'):timing[field]+=render[field]
                timing['worstWindowP99Ms']=max(timing['worstWindowP99Ms'],render['p99Ms'])
                if timing['worstFrame'] is None or render['maxMs']>timing['worstFrame']['maxMs']:
                    timing['worstFrame']={key:render[key] for key in ('maxMs','recordMs','renderMs','waitMs','idleMs')}
            # Loading, background and accelerated replay are not normal play FPS.
            if row['hiddenMs']+row['inactiveMs']+row['catchupMs']<=250:
                peer['normalWindows']+=1;peer['normalMs']+=row['windowMs'];peer['normalFrames']+=row['frames']
                peer['noProgressMs']+=row['noProgressMs']
                peer['minFps']=row['gameFps'] if peer['minFps'] is None else min(peer['minFps'],row['gameFps'])
            if row['rttMs'] is not None:
                count=max(0,row['probes']-row['probeTimeouts'])
                peer['rttSum']+=row['rttMs']*count;peer['rttCount']+=count
                peer['maxRttMs']=max(peer['maxRttMs'] or 0,row['rttMaxMs'] or 0)
        except (ValueError,TypeError,KeyError,AttributeError):
            continue
    for group in groups.values():
        for peer in group['peers'].values():
            ms=peer.pop('normalMs');frames=peer.pop('normalFrames');rtt=peer.pop('rttSum');count=peer.pop('rttCount');stalled=peer.pop('noProgressMs')
            peer['averageGameFps']=round(frames*1000/ms,2) if ms else None
            peer['noProgressPercent']=round(stalled*100/ms,2) if ms else None
            peer['averageRttMs']=round(rtt/count,2) if count else None
    return list(groups.values())

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--room',help='Exact room name or code (case insensitive)')
    args=parser.parse_args()
    print(json.dumps(summarize(sys.stdin,args.room),indent=2))
