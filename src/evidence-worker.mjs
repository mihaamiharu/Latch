import {executeCLI} from './cli.mjs';
import {cliError, CLI_META} from './redact.mjs';
process.once('disconnect',()=>process.exit(1));
process.once('message',async invocation=>{
  let response;
  try {const result=await executeCLI(invocation);response={ok:true,result,upstream:result?.[CLI_META]||null};}
  catch(error){process.exitCode=1;response={ok:false,error:cliError(error)};}
  process.send(response,()=>{process.removeAllListeners('disconnect');process.disconnect();});
});
