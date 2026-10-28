import http from 'node:http';

export async function popupApp() {
  const states = new Map(), seeds = new Map();
  let alternate;
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'POST') {
      let body = ''; req.on('data', data => body += data);
      req.on('end', () => {
        const value = JSON.parse(body);
        if (url.pathname === '/__seed') seeds.set(value.run, value);
        else states.set(value.pageId, {...value, at: Date.now()});
        res.end('ok');
      }); return;
    }
    if (url.pathname === '/redirect') { res.writeHead(302, {Location: '/child'}); res.end(); return; }
    res.setHeader('Set-Cookie', 'latch_fixture=signed-in; Path=/; SameSite=Lax');
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Latch popup fixture</title><h1>Attachment fixture</h1><p id="actor"></p><p id="role">${url.pathname}</p>
      <label>Value <input id="value"></label><button id="save">Save</button><p id="result">Waiting</p>
      <a id="blank" target="_blank" rel="opener">Open details</a> <a id="noopener" target="_blank" rel="noopener">Open without JS opener</a>
      <button id="window">Open window</button><button id="delayed">Open blank then redirect</button><button id="cross">Open cross-origin</button>
      <button id="nested">Open nested</button><button id="auth">Authenticate</button><button id="fast">Open immediately closing popup</button><button id="blocked">Try sandbox-blocked popup</button><button id="close">Close this tab</button>
      <script>
      const actor=sessionStorage.getItem('actor')||decodeURIComponent(location.hash.slice(1));
      sessionStorage.setItem('actor',actor);localStorage.setItem('latch-fixture-marker','pre-existing');
      history.replaceState({},'',location.pathname);document.querySelector('#actor').textContent=actor;
      const pageId=crypto.randomUUID();const fragment='#'+encodeURIComponent(actor);
      document.querySelector('#blank').href='/child'+fragment;document.querySelector('#noopener').href='/child'+fragment;
      document.querySelector('#save').onclick=async()=>{document.querySelector('#result').textContent='Saved '+document.querySelector('#value').value;console.error('fixture-'+actor)};
      document.querySelector('#window').onclick=()=>window.open('/child'+fragment,'_blank');
      document.querySelector('#delayed').onclick=()=>{const w=window.open('about:blank');if(w)setTimeout(()=>w.location='/redirect'+fragment,150)};
      document.querySelector('#cross').onclick=()=>window.open(${JSON.stringify(alternate || '')}+'/child'+fragment,'_blank');
      document.querySelector('#nested').onclick=()=>window.open('/nested'+fragment,'_blank');
      document.querySelector('#auth').onclick=()=>window.open('/auth'+fragment,'_blank');
      document.querySelector('#fast').onclick=()=>window.open('/fast-close'+fragment,'_blank');
      document.querySelector('#blocked').onclick=()=>{const f=document.createElement('iframe');f.id='blocked-fixture';f.sandbox='allow-scripts allow-same-origin';f.srcdoc='<script>parent.postMessage({fixtureBlocked:window.open("/child#blocked-probe","_blank")===null},"*")<'+ '/script>';document.body.append(f)};
      document.querySelector('#close').onclick=()=>window.close();
      addEventListener('message',e=>{if(e.data==='fixture-auth-ok')document.querySelector('#result').textContent='Authenticated';if(e.data?.fixtureBlocked!==undefined){document.body.dataset.blockedPopup=e.data.fixtureBlocked?'yes':'no';document.querySelector('#blocked-fixture')?.remove()}});
      const report=()=>fetch('/__state',{method:'POST',body:JSON.stringify({pageId,actor,role:location.pathname,result:document.querySelector('#result').textContent,signedIn:document.cookie.includes('latch_fixture=signed-in'),marker:localStorage.getItem('latch-fixture-marker')})});
      report();setInterval(report,500);
      if(location.pathname==='/auth')setTimeout(()=>{if(opener)opener.postMessage('fixture-auth-ok','*');window.close()},500);
      if(location.pathname==='/fast-close')window.close();
      </script>`);
  };
  const a = http.createServer(handler), b = http.createServer(handler);
  await new Promise(resolve => a.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => b.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${a.address().port}`;
  alternate = `http://127.0.0.1:${b.address().port}`;
  return {origin, alternate, states, seeds,
    close: async () => { await Promise.all([a,b].map(s => new Promise(resolve => { s.close(resolve); s.closeAllConnections(); }))); }};
}
