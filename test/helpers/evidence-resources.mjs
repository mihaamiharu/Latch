import {execFile} from 'node:child_process';import {promisify} from 'node:util';import assert from 'node:assert/strict';
const exec=promisify(execFile);
async function processRows(){
 if(process.platform==='win32'){
  const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],{maxBuffer:64*1024*1024,windowsHide:true});
  return JSON.parse(stdout).map(r=>({pid:r.ProcessId,ppid:r.ParentProcessId,command:(r.CommandLine||'').replaceAll('\\','/')}));
 }
 const {stdout}=await exec('ps',['-ax','-o','pid=,ppid=,command=']);
 return stdout.split('\n').map(s=>{const m=s.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m&&{pid:+m[1],ppid:+m[2],command:m[3]}}).filter(Boolean);
}
export async function nativeHostPID(browserPID,bootFile){
 const rows=await processRows(),owned=new Set([browserPID]);
 for(let changed=true;changed;){changed=false;for(const r of rows)if(owned.has(r.ppid)&&!owned.has(r.pid)){owned.add(r.pid);changed=true}}
 // On Windows the host runs as cmd.exe -> node.exe; only the node process matches.
 const host=rows.filter(r=>owned.has(r.pid)&&!/cmd\.exe/i.test(r.command.split(' ')[0])&&(bootFile?r.command.includes(bootFile+' native-host'):r.command.includes('/src/native-host.mjs')));assert.equal(host.length,1,'Only this fixture browser native host may be sampled');return host[0].pid;
}
export async function tcpResources(pid){
 const result=await exec('lsof',['-a','-p',String(pid),'-iTCP','-FfT']).catch(error=>{if(error.code===1&&!error.stdout)return {stdout:''};throw error});
 return {tcpSockets:(result.stdout.match(/^f\d+/gm)||[]).length,listeners:(result.stdout.match(/^TST=LISTEN$/gm)||[]).length};
}
