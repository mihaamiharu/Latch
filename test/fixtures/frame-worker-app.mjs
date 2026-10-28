import http from 'node:http';
import crypto from 'node:crypto';

export async function frameWorkerApp() {
  const states=new Map(),seeds=new Map();let origins;
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture');res.setHeader('Access-Control-Allow-Origin','*');
    if(req.method==='POST'){
      let body='';req.on('data',b=>body+=b);req.on('end',()=>{const value=JSON.parse(body);
        if(url.pathname==='/__seed')seeds.set(value.run,value);else states.set(value.instance,{...value,at:Date.now()});res.end('ok');});return;
    }
    if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return}
    const instance=crypto.randomUUID();
    if(url.pathname==='/worker.js'){
      res.setHeader('Content-Type','application/javascript');res.setHeader('Cache-Control','no-store');
      res.end(`self.fixture={instance:${JSON.stringify(instance)},actor:null};onmessage=async e=>{if(e.data.init){self.fixture.actor=e.data.actor;self.fixture.parent=e.data.parent;await fetch('/state',{method:'POST',body:JSON.stringify({...self.fixture,role:'worker',result:'ready'})});self.fixture.ready=true;postMessage({ready:true,...self.fixture})}else postMessage({reply:e.data, ...self.fixture})};`);return;
    }
    const root=url.pathname==='/root',kind=root?'root':url.searchParams.get('kind')||'same';
    res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','no-store');
    res.end(`<title>Latch frame/worker fixture</title><h1>${kind}</h1><p id="actor"></p><p id="instance">${instance}</p>
      <label>Value <input id="value"></label><button id="save">Save</button><p id="result">Waiting</p><button id="emit">Emit evidence</button>
      <button id="start-worker">Start worker</button><button id="stop-worker">Stop worker</button><p id="worker-result">Waiting</p>
      ${root?'<button id="insert">Insert frame</button><button id="remove">Remove frame</button><button id="navigate">Navigate frame</button><button id="replace">Replace cross frame</button><button id="remove-cross">Remove cross subtree</button>':''}
      <script>
      const actor=decodeURIComponent(location.hash.slice(1))||sessionStorage.getItem('fixture-actor');sessionStorage.setItem('fixture-actor',actor);
      history.replaceState({},'',location.pathname+location.search);document.querySelector('#actor').textContent=actor;
      window.fixture={actor,instance:${JSON.stringify(instance)},role:${JSON.stringify(kind)}};window.fixtureWorkers={};
      const report=result=>fetch('/state',{method:'POST',body:JSON.stringify({...fixture,result})});report('ready');
      document.querySelector('#save').onclick=()=>{const result='Saved '+document.querySelector('#value').value;document.querySelector('#result').textContent=result;report(result)};
      document.querySelector('#emit').onclick=()=>{console.error('frame-console:'+actor+':'+fixture.role);fetch('/event?marker='+encodeURIComponent(actor+':'+fixture.role));setTimeout(()=>{throw new Error('frame-error:'+actor+':'+fixture.role)},0)};
      function startWorker(name){const w=new Worker('/worker.js');fixtureWorkers[name]=w;w.onmessage=e=>{document.querySelector('#worker-result').textContent=JSON.stringify(e.data)};w.postMessage({init:true,actor,parent:fixture.instance});return w}
      document.querySelector('#start-worker').onclick=()=>startWorker('dynamic');document.querySelector('#stop-worker').onclick=()=>fixtureWorkers.dynamic?.terminate();
      function add(id,origin,role){const f=document.createElement('iframe');f.id=id;f.name=id;f.src=origin+'/frame?kind='+role+'#'+encodeURIComponent(actor);f.width=520;f.height=330;document.body.append(f);return f}
      ${root?`add('same',${JSON.stringify(origins.a)},'same');add('cross',${JSON.stringify(origins.b)},'cross');add('moving',${JSON.stringify(origins.a)},'moving');startWorker('existing');
      document.querySelector('#insert').onclick=()=>add('dynamic',${JSON.stringify(origins.a)},'dynamic');document.querySelector('#remove').onclick=()=>document.querySelector('#dynamic')?.remove();
      let moved=false;document.querySelector('#navigate').onclick=()=>{moved=!moved;document.querySelector('#moving').src=(moved?${JSON.stringify(origins.b)}:${JSON.stringify(origins.a)})+'/frame?kind=moving#'+encodeURIComponent(actor)};
      document.querySelector('#replace').onclick=()=>{document.querySelector('#cross').remove();add('cross',${JSON.stringify(origins.b)},'replacement')};
      document.querySelector('#remove-cross').onclick=()=>document.querySelector('#cross')?.remove();`
      :kind==='cross'?`add('nested',${JSON.stringify(origins.c)},'nested');startWorker('iframe-existing');`:''}
      </script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;origins={a:`http://a.latch.test:${port}`,b:`http://b.other.test:${port}`,c:`http://c.third.test:${port}`};
  return {origin:origins.a,origins,states,seeds,rootRole:'root',protocolEvidence:true,
    launchArgs:['--site-per-process','--no-proxy-server','--host-resolver-rules=MAP a.latch.test 127.0.0.1,MAP b.other.test 127.0.0.1,MAP c.third.test 127.0.0.1'],
    close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})};
}
