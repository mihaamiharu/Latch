// A backlog threshold plus one bounded message, not a process-memory cap.
export const TRANSPORT_LIMITS = Object.freeze({message:32*1024*1024,backlog:8*1024*1024,pending:64,ordinaryMs:10000,awaitedMs:30000});
export function prepareWire(value,bufferedAmount){
 if(bufferedAmount>TRANSPORT_LIMITS.backlog)throw Object.assign(new Error('Transport backlog exceeded 8 MiB.'),{code:'TRANSPORT_BACKLOG'});
 const text=JSON.stringify(value),bytes=new TextEncoder().encode(text).length;
 if(bytes>TRANSPORT_LIMITS.message)throw Object.assign(new Error('Serialized transport message exceeded 32 MiB.'),{code:'WIRE_MESSAGE_TOO_LARGE'});
 return {text,bytes};
}
export function browserDeadline(method,params){
 if(method==='command'){
  if(['Runtime.evaluate','Runtime.callFunctionOn'].includes(params?.method)&&params?.params?.awaitPromise===true)
   return TRANSPORT_LIMITS.awaitedMs;
  if(['Page.navigate','Page.reload','Page.navigateToHistoryEntry'].includes(params?.method))
   return TRANSPORT_LIMITS.awaitedMs;
 }
 return TRANSPORT_LIMITS.ordinaryMs;
}
