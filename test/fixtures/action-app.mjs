import http from 'node:http';

// Independent save receipts distinguish a completed UI action from a CLI exit.
export async function actionApp() {
  const states = new Map(), seeds = new Map(), receipts = [];
  const server = http.createServer((req,res) => {
    const url = new URL(req.url,'http://fixture');
    if (req.method === 'POST') {
      let body='';req.on('data',chunk=>{body+=chunk;if(body.length>16384)req.destroy()});
      req.on('end',()=>{
        try {
          const value=JSON.parse(body);
          if(url.pathname==='/__seed')seeds.set(value.run,value);
          else if(url.pathname==='/save')receipts.push({...value,sequence:receipts.length+1});
          else states.set(value.pageId,{...value,at:Date.now()});
          res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));
        }catch{res.writeHead(400);res.end()}
      });return;
    }
    res.setHeader('Content-Type','text/html');
    res.end(`<title>Latch action diagnostics</title><h1>Action fixture</h1><p id="actor"></p>
      <div role="textbox" aria-label="Outline" contenteditable="true" class="cm-content">Initial outline</div>
      <button id="save">Update Test Case</button><p id="result">Waiting</p>
      <script>
      const actor=decodeURIComponent(location.hash.slice(1)),pageId=crypto.randomUUID();
      document.querySelector('#actor').textContent=actor;
      document.querySelector('#save').onclick=async()=>{
        const value=document.querySelector('.cm-content').innerText;
        const r=await fetch('/save',{method:'POST',body:JSON.stringify({actor,value})});
        if(r.ok)document.querySelector('#result').textContent='Saved '+value;
      };
      const report=()=>fetch('/__state',{method:'POST',body:JSON.stringify({pageId,actor,role:'/root',result:document.querySelector('#result').textContent})});
      report();setInterval(report,250);
      </script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {origin:`http://127.0.0.1:${server.address().port}`,states,seeds,receipts,
    close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})};
}
