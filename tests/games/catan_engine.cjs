const assert=require('node:assert/strict');
const E=require('../../static/js/catan-engine.js');
const fresh=()=>{const random=Math.random;Math.random=()=>0;try{return E.create(['A','B','C','D']);}finally{Math.random=random;}};
const random=Math.random;Math.random=()=>.6;const rotated=E.create(['A','B','C','D']);Math.random=random;
assert.equal(rotated.startSeat,2);assert.equal(rotated.current,2);
assert.equal(E.vertices.length,54);assert.equal(E.edges.length,72);
assert.equal(new Set(E.ports.flatMap(p=>E.edges[p.edge].ends)).size,18);
const s=fresh(),order=[];
assert.equal(E.roll(s),false);assert.equal(E.end(s),false);
for(let i=0;i<8;i++){
    order.push(s.current);
    const v=E.legal(s,'settlement')[0],owner=s.current,before=E.total(s.players[owner]);
    assert.ok(E.build(s,'settlement',v));
    assert.equal(E.build(s,'settlement',v),false);
    assert.ok(E.legal(s,'road').every(e=>E.edges[e].ends.includes(v)));
    if(i>=4)assert.equal(E.total(s.players[owner])-before,E.vertices[v].tiles.filter(t=>E.tiles[t].type!=='desert').length);
    assert.ok(E.build(s,'road',E.legal(s,'road')[0]));
}
assert.deepEqual(order,[0,1,2,3,3,2,1,0]);assert.equal(s.phase,'roll');
assert.ok(s.players.every(p=>p.vp===2&&p.road===13&&p.settlement===3));
// Production reaches every occupied adjacent vertex and cities receive two.
const p=fresh();p.phase='roll';const t=E.tiles[0];
p.buildings[t.corners[0]]={owner:1,kind:'city'};p.buildings[t.corners[2]]={owner:2,kind:'settlement'};
let dice=[0.2,0.4];assert.ok(E.roll(p,()=>dice.shift()));assert.deepEqual(p.dice,[2,3]);
assert.deepEqual(p.rolls,[{player:0,dice:[2,3]}]);
assert.equal(p.players[1].resources.wood,2);assert.equal(p.players[2].resources.wood,1);assert.equal(E.roll(p),false);
// Robber blocks production; discards gate the turn and return cards to the bank.
p.phase='roll';p.robber=0;dice=[0.2,0.4];E.roll(p,()=>dice.shift());assert.equal(p.players[1].resources.wood,2);
p.phase='roll';p.players[0].resources.ore=8;p.bank.ore=11;dice=[0,0.99];E.roll(p,()=>dice.shift());
assert.equal(p.phase,'discard');assert.equal(E.end(p),false);
for(let i=0;i<4;i++)assert.ok(E.discard(p,'ore'));
assert.equal(p.phase,'robber');assert.equal(E.moveRobber(p,0),false);assert.ok(E.moveRobber(p,1));
// Port ownership changes only the matching trade rate.
const q=fresh();q.phase='build';const port=E.ports.find(p=>p.type==='wood');
q.buildings[E.edges[port.edge].ends[0]]={owner:0,kind:'settlement'};
assert.equal(E.rate(q,'wood'),2);assert.equal(E.rate(q,'ore'),4);
q.players[0].resources.wood=2;q.bank.wood=17;assert.ok(E.trade(q,'wood','ore'));assert.equal(q.players[0].resources.ore,1);assert.equal(q.bank.wood,19);
assert.equal(E.trade(q,'ore','ore'),false);
// Invalid builds do not charge; valid roads charge at placement, not at end turn.
s.phase='build';s.players[0].resources.wood=2;s.players[0].resources.brick=2;
assert.equal(E.build(s,'road',999),false);assert.equal(s.players[0].resources.wood,2);
assert.ok(E.build(s,'road',E.legal(s,'road')[0]));assert.equal(s.players[0].resources.wood,1);
assert.ok(E.end(s));assert.equal(s.current,1);
// Cities upgrade owned settlements, restore a settlement piece and win on ten.
const w=fresh();w.phase='build';w.buildings[0]={owner:0,kind:'settlement'};
w.players[0].resources.wheat=2;w.players[0].resources.ore=3;w.players[0].vp=9;
assert.ok(E.build(w,'city',0));assert.equal(w.buildings[0].kind,'city');assert.equal(w.players[0].settlement,6);
assert.equal(w.winner,0);assert.equal(E.end(w),false);assert.equal(E.trade(w,'wood','ore'),false);
const r=fresh();r.phase='robber';r.buildings[E.tiles[0].corners[0]]={owner:1,kind:'settlement'};r.players[1].resources.wood=1;
assert.ok(E.moveRobber(r,0));assert.equal(r.phase,'steal');assert.equal(E.steal(r,2),false);
assert.ok(E.steal(r,1,()=>0));assert.equal(r.players[0].resources.wood,1);assert.equal(r.phase,'build');
console.log('PASS: topology, setup order, distance/connection, initial resources, production, robber/discard, ports, trades, paid builds and turn gates.');
