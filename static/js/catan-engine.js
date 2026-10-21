/* Local hotseat rules. No connection to the live service. */
(function (scope) {
    'use strict';
    const resources = ['wood', 'brick', 'wheat', 'sheep', 'ore'];
    const terrain = ['wood','sheep','wheat','brick','ore','wood','wheat','sheep','wood','desert','brick','sheep','ore','wheat','wood','brick','sheep','ore','wheat'];
    const numbers = [5,2,6,3,8,10,9,4,10,null,9,4,8,3,6,5,11,12,11];
    const positions = [[23,2],[41,2],[59,2],[14,20],[32,20],[50,20],[68,20],[5,38],[23,38],[41,38],[59,38],[77,38],[14,56],[32,56],[50,56],[68,56],[23,74],[41,74],[59,74]];
    const vertices = [], edges = [], tiles = [];
    positions.forEach(([x,y], id) => {
        const corners = [[9,0],[18,6],[18,18],[9,24],[0,18],[0,6]].map(([dx,dy]) => {
            let v = vertices.find(v => v.x === x+dx && v.y === y+dy);
            if (!v) { v = {id:vertices.length,x:x+dx,y:y+dy,tiles:[],edges:[]}; vertices.push(v); }
            v.tiles.push(id); return v.id;
        });
        corners.forEach((a,i) => {
            const b = corners[(i+1)%6];
            let e = edges.find(e => e.ends.includes(a) && e.ends.includes(b));
            if (!e) { e = {id:edges.length,ends:[a,b],tiles:[]}; edges.push(e); vertices[a].edges.push(e.id); vertices[b].edges.push(e.id); }
            e.tiles.push(id);
        });
        tiles.push({id,x,y,type:terrain[id],number:numbers[id],corners});
    });
    const coast = edges.filter(e => e.tiles.length === 1).sort((a,b) => {
        const angle = e => Math.atan2((vertices[e.ends[0]].y+vertices[e.ends[1]].y)/2-50,(vertices[e.ends[0]].x+vertices[e.ends[1]].x)/2-50);
        return angle(a)-angle(b);
    });
    // Coastal pairs follow the reference board, clockwise from the upper left.
    const portCorners = [[[23,8],[32,2]],[[50,2],[59,8]],[[77,20],[86,26]],[[95,44],[95,56]],[[86,74],[77,80]],[[59,92],[68,98]],[[23,92],[32,98]],[[14,62],[14,74]],[[14,26],[14,38]]];
    const ports = portCorners.map((pair,j) => {
        const ends=pair.map(([x,y])=>vertices.find(v=>v.x===x&&v.y===y).id);
        return {edge:coast.find(e=>ends.every(v=>e.ends.includes(v))).id,type:['wood','any','any','brick','wheat','ore','sheep','any','any'][j]};
    });
    const costs = {road:{wood:1,brick:1},settlement:{wood:1,brick:1,wheat:1,sheep:1},city:{wheat:2,ore:3}};
    const bag = amount => Object.fromEntries(resources.map(r => [r,amount]));
    const total = p => resources.reduce((n,r) => n+p.resources[r],0);
    function create(names) {
        const startSeat=Math.floor(Math.random()*names.length);
        return {current:startSeat,startSeat,phase:'setup-settlement',setup:0,anchor:null,buildings:{},roads:{},bank:bag(19),robber:9,dice:null,winner:null,discard:[],victims:[],rolls:[],
            players:names.map(name => ({name,resources:bag(0),vp:0,road:15,settlement:5,city:4}))};
    }
    function distanceClear(s,id) {
        return !s.buildings[id] && vertices[id].edges.every(e => edges[e].ends.every(v => !s.buildings[v]));
    }
    function connected(s,v) {
        const b = s.buildings[v];
        return b ? b.owner === s.current : vertices[v].edges.some(e => s.roads[e] === s.current);
    }
    function legal(s,kind) {
        if (s.winner !== null) return [];
        const setup = s.phase.startsWith('setup');
        if (setup && s.phase !== 'setup-'+kind || !setup && s.phase !== 'build') return [];
        if (kind === 'road') return edges.filter(e => s.roads[e.id] === undefined && (setup ? e.ends.includes(s.anchor) : e.ends.some(v => connected(s,v)))).map(e => e.id);
        if (kind === 'settlement') return vertices.filter(v => distanceClear(s,v.id) && (setup || v.edges.some(e => s.roads[e] === s.current))).map(v => v.id);
        if (kind === 'city') return vertices.filter(v => s.buildings[v.id]?.owner === s.current && s.buildings[v.id].kind === 'settlement').map(v => v.id);
        return [];
    }
    const affordable = (s,kind) => !!costs[kind] && s.players[s.current][kind] > 0 && Object.entries(costs[kind]).every(([r,n]) => s.players[s.current].resources[r] >= n);
    function give(s,owner,r,n) { if (s.bank[r] >= n) {s.bank[r]-=n;s.players[owner].resources[r]+=n;} }
    function build(s,kind,id) {
        const setup = s.phase.startsWith('setup');
        if (!legal(s,kind).includes(id) || !setup && !affordable(s,kind)) return false;
        const p = s.players[s.current];
        if (!setup) Object.entries(costs[kind]).forEach(([r,n]) => {p.resources[r]-=n;s.bank[r]+=n;});
        p[kind]--;
        if (kind === 'road') s.roads[id] = s.current;
        else {s.buildings[id]={owner:s.current,kind};p.vp++;if(kind==='city')p.settlement++;}
        if (setup && kind === 'settlement') {
            s.anchor=id;s.phase='setup-road';
            if(s.setup>=4) vertices[id].tiles.forEach(t => {const r=tiles[t].type;if(r!=='desert')give(s,s.current,r,1);});
        } else if(setup) {
            s.setup++;s.anchor=null;
            const order=Array.from({length:s.players.length},(_,i)=>(s.startSeat+i)%s.players.length);
            if(s.setup===s.players.length*2){s.current=s.startSeat;s.phase='roll';}else{s.current=[...order,...order.slice().reverse()][s.setup];s.phase='setup-settlement';}
        }
        if(p.vp>=10){s.winner=s.current;s.phase='finished';}
        return true;
    }
    function roll(s,random=Math.random) {
        if(s.phase!=='roll')return false;
        s.dice=[1+Math.floor(random()*6),1+Math.floor(random()*6)];
        s.rolls.push({player:s.current,dice:[...s.dice]});
        const sum=s.dice[0]+s.dice[1];
        if(sum===7){
            s.discard=s.players.map((p,owner)=>({owner,left:total(p)>7?Math.floor(total(p)/2):0})).filter(d=>d.left);
            s.phase=s.discard.length?'discard':'robber';
        } else {
            const demand = s.players.map(()=>bag(0));
            tiles.filter(t=>t.number===sum && t.id!==s.robber).forEach(t=>t.corners.forEach(v=>{const b=s.buildings[v];if(b)demand[b.owner][t.type]+=b.kind==='city'?2:1;}));
            resources.forEach(r=>{
                const recipients=demand.map((d,i)=>({i,n:d[r]})).filter(d=>d.n);
                const needed=recipients.reduce((n,d)=>n+d.n,0);
                if(needed<=s.bank[r])recipients.forEach(d=>give(s,d.i,r,d.n));
                else if(recipients.length===1)give(s,recipients[0].i,r,s.bank[r]);
            });
            s.phase='build';
        }
        return true;
    }
    function discard(s,r) {
        const d=s.discard[0];
        if(s.phase!=='discard'||!d||!resources.includes(r)||!s.players[d.owner].resources[r])return false;
        s.players[d.owner].resources[r]--;s.bank[r]++;d.left--;
        if(!d.left)s.discard.shift();
        if(!s.discard.length)s.phase='robber';
        return true;
    }
    function moveRobber(s,id) {
        if(s.phase!=='robber'||!tiles[id]||id===s.robber)return false;
        s.robber=id;
        s.victims=[...new Set(tiles[id].corners.map(v=>s.buildings[v]?.owner).filter(o=>o!==undefined&&o!==s.current&&total(s.players[o])>0))];
        s.phase=s.victims.length?'steal':'build';return true;
    }
    function steal(s,owner,random=Math.random) {
        if(s.phase!=='steal'||!s.victims.includes(owner))return false;
        const cards=resources.flatMap(r=>Array(s.players[owner].resources[r]).fill(r));
        const r=cards[Math.floor(random()*cards.length)];
        s.players[owner].resources[r]--;s.players[s.current].resources[r]++;s.victims=[];s.phase='build';return true;
    }
    function rate(s,r) {
        let n=4;
        ports.forEach(p=>{if(edges[p.edge].ends.some(v=>s.buildings[v]?.owner===s.current)){if(p.type==='any')n=Math.min(n,3);if(p.type===r)n=2;}});
        return n;
    }
    function trade(s,from,to) {
        if(s.phase!=='build'||!resources.includes(from)||!resources.includes(to)||from===to||s.bank[to]<1)return false;
        const p=s.players[s.current],n=rate(s,from);
        if(p.resources[from]<n)return false;
        p.resources[from]-=n;s.bank[from]+=n;give(s,s.current,to,1);return true;
    }
    function end(s) {if(s.phase!=='build')return false;s.current=(s.current+1)%4;s.phase='roll';return true;}
    const api={resources,tiles,vertices,edges,ports,create,legal,affordable,build,roll,discard,moveRobber,steal,rate,trade,end,total};
    if(typeof module!=='undefined')module.exports=api;else scope.CatanEngine=api;
})(globalThis);
