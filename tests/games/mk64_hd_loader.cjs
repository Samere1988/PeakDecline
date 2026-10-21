const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../ports/mk64/hd_textures.js'),'utf8');
const delay=()=>new Promise(r=>setTimeout(r,0));
function fixture(bootstrap=false){
    const requests=[],uploads=[],a={},b={},gl={TEXTURE_BINDING_2D:1,TEXTURE_2D:2,RGBA:3,UNSIGNED_BYTE:4,
        current:a,getParameter(){return this.current},isContextLost(){return false},isTexture(){return true},
        bindTexture(_,texture){this.current=texture},texImage2D(...args){uploads.push({texture:this.current,image:args.at(-1)})}};
    const Module={mk64HDManifest:{assetId:'fixture',pack:'Fixture',release:'fixture',textures:{
        '2x2:00000001:00000002':['textures/first.webp','first','textures/karts/first.png',8,8],
        '2x2:00000003:00000004':['textures/second.webp','second','textures/common_data/second.png',8,8]}}};
    if(bootstrap) Module.mk64HDManifest.textures=Object.fromEntries(Array.from({length:10},(_,i)=>[String(i),['textures/'+i+'.webp',String(i),'textures/startup_logo/'+i+'.png',8,8]]));
    let dependencies=0;
    const context={addRunDependency(){dependencies++},removeRunDependency(){dependencies--},Module,URL,AbortController,location:{href:'http://fixture.test/'},console:{warn(){}},
        fetch:(url,options)=>new Promise((resolve,reject)=>{
            requests.push({url,resolve:()=>resolve({ok:true,blob:async()=>({})})});
            options.signal.addEventListener('abort',()=>reject(new Error('aborted')));
        }),createImageBitmap:async()=>({width:8,height:8,closed:false,close(){this.closed=true}})};
    vm.runInNewContext(source,context);return{Module,gl,a,b,requests,uploads,dependencies:()=>dependencies};
}
(async()=>{
    {
        const f=fixture();f.Module.mk64HD.replace(f.gl,2,2,1,2);
        f.gl.current=f.b;f.Module.mk64HD.replace(f.gl,2,2,1,2);
        assert.equal(f.requests.length,1,'parallel bindings share one download');
        f.requests[0].resolve();await delay();await delay();
        assert.equal(f.uploads.length,2);assert.equal(f.gl.current,f.b,'replacement restores current texture binding');
        assert.equal(f.Module.mk64HD.stats.applied,2);
        f.Module.mk64HD.dispose();assert(f.uploads[0].image.closed);
    }
    {
        const f=fixture();f.Module.mk64HD.replace(f.gl,2,2,1,2);
        f.Module.mk64HD.replace(f.gl,2,2,99,99); // recycled GPU slot now holds different original pixels
        f.requests[0].resolve();await delay();await delay();
        assert.equal(f.uploads.length,0,'late decode cannot overwrite a recycled texture');
        f.Module.mk64HD.replace(f.gl,2,2,1,2);assert.equal(f.uploads.length,1,'cached image applies immediately');
        f.Module.mk64HD.dispose();
    }
    {
        const f=fixture();f.Module.mk64HD.replace(f.gl,2,2,1,2);f.Module.mk64HD.dispose();
        await delay();await delay();assert.equal(f.uploads.length,0,'retired module cannot upload into the new game');
    }
    {
        const f=fixture(true);f.Module.preRun[0]();
        assert.equal(f.requests.length,6,'bootstrap obeys download concurrency');
        assert.equal(f.dependencies(),1);
        f.Module.mk64HD.dispose();
        await f.Module.mk64HD.ready.catch(()=>{});await delay();
        assert.equal(f.dependencies(),0,'cancelled queued bootstrap releases startup dependency');
        assert.equal(f.requests.length,6,'queued downloads never start after disposal');
    }
    console.log('MK64 HD loader: shared requests, binding restoration, recycled slots and cancellation passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
