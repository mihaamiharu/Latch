const status = await chrome.runtime.sendMessage({type: 'status'});
document.querySelector('#connection').textContent = status.connected ? 'Local bridge connected' : 'Local bridge disconnected';
document.querySelector('#status').textContent = JSON.stringify({...status, lastError: status.connected ? '' : status.lastError}, null, 2);
