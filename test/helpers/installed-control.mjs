// Runs only inside the disposable installation fixture's separate test
// extension. The packaged Latch extension is never patched for these UI checks.
export function installedControl(endpoint,id,popup) {
  return `const endpoint=${JSON.stringify(endpoint)},id=${JSON.stringify(id)};
  let busy=false;
  setInterval(async()=>{
    if(busy)return;busy=true;let task;
    try{
      task=await(await fetch(endpoint)).json();if(!task)return;let result;
      if(['enable','disable'].includes(task.action)){await chrome.management.setEnabled(id,task.action==='enable');result=await chrome.management.get(id)}
      else if(task.action==='extension-info')result=await chrome.management.get(id);
      ${popup?`else if(task.action==='popup'){
        const tab=(await chrome.tabs.query({url:'chrome-extension://'+id+'/popup.html'}))[0]||await chrome.tabs.create({url:'chrome-extension://'+id+'/popup.html',active:false});
        const deadline=Date.now()+3000;let loaded=false;
        while(Date.now()<deadline){const current=await chrome.tabs.get(tab.id);if(current.status==='complete'&&current.url==='chrome-extension://'+id+'/popup.html'){loaded=true;break}await new Promise(r=>setTimeout(r,25))}
        if(!loaded)throw new Error('Popup did not finish its initial navigation; no action was evaluated.');
        try{
          await chrome.debugger.attach({tabId:tab.id},'1.3');
          const value=await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:task.params.expression,awaitPromise:true,returnByValue:true});
          if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);
          result={value:value.result.value};
        }finally{await chrome.debugger.detach({tabId:tab.id}).catch(()=>{})}
      }`:''}
      else throw new Error('Unsupported install fixture action');
      await fetch(endpoint,{method:'POST',body:JSON.stringify({id:task.id,result})});
    }catch(e){if(task)await fetch(endpoint,{method:'POST',body:JSON.stringify({id:task.id,error:e.message})})}
    finally{busy=false}
  },100);`;
}
