"""Bounded local workload, not a production capacity guarantee."""
import json
import statistics
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from catan_online_test import test_app

with tempfile.TemporaryDirectory(prefix='catan-load-') as directory:
    app,_=test_app(Path(directory)/'load.sqlite3')
    clients=[];rooms=[]
    def post(client,token,id,version,type,**kwargs):
        response=client.post('/api/catan/rooms/'+id+'/actions',json=dict(command=uuid.uuid4().hex,version=version,type=type,**kwargs),headers={'X-Catan-CSRF':token})
        assert response.status_code==200,response.json
        return response.json
    for group in range(24):
        members=[]
        for i in range(4):
            client=app.test_client()
            with client.session_transaction() as session:session['_user_id']=str(group*4+i)
            token=client.get('/api/catan/lobby').json['csrf'];members.append((client,token))
        client,token=members[0]
        room=client.post('/api/catan/rooms',json={'name':'Load '+str(group)},headers={'X-Catan-CSRF':token}).json
        for c,t in members[1:]:room=post(c,t,room['id'],room['version'],'join')
        for c,t in members:room=post(c,t,room['id'],room['version'],'ready')
        room=post(client,token,room['id'],room['version'],'start')
        rooms.append(room);clients.extend((c,t,room['id']) for c,t in members)
    def exercise(index):
        c,t,id=clients[index];timings=[]
        for _ in range(10):
            start=time.perf_counter();response=c.get('/api/catan/rooms/'+id);timings.append(time.perf_counter()-start)
            assert response.status_code==200,response.json
            assert response.json['id']==id
            assert sum(p['resources'] is not None for p in response.json['game']['players'])==1
        return timings
    start=time.perf_counter()
    with ThreadPoolExecutor(max_workers=16) as pool:timings=[n for values in pool.map(exercise,range(96)) for n in values]
    elapsed=time.perf_counter()-start
    # Concurrent first placements in all rooms test serialized writes and isolation.
    def move(index):
        id=clients[index*4][2]
        room=clients[index*4][0].get('/api/catan/rooms/'+id).json
        c,t,_=clients[index*4+room['game']['current']]
        room=c.get('/api/catan/rooms/'+id).json
        return post(c,t,id,room['version'],'build',piece='settlement',target=room['game']['legal']['settlement'][0])
    with ThreadPoolExecutor(max_workers=12) as pool:results=list(pool.map(move,range(24)))
    assert all(len(r['game']['buildings'])==1 for r in results)
    print(json.dumps(dict(rooms=24,players=96,snapshot_requests=len(timings),concurrent_workers=16,elapsed_seconds=round(elapsed,3),median_ms=round(statistics.median(timings)*1000,2),p95_ms=round(sorted(timings)[int(len(timings)*.95)]*1000,2),simultaneous_room_moves=24,errors=0)))
