// Related debugger targets are scoped to an owned top-level page. Never infer
// parentage from URL or target creation time.
export const CHILD_LIMITS=Object.freeze({perTab:64,perLease:256,depth:16,retired:1024});
export function childFilter(requested){
  const filter=requested||[{}];
  return ['iframe','worker'].filter(type=>{const match=filter.find(e=>!e.type||e.type===type);return match&&!match.exclude})
    .map(type=>({type,exclude:false})).concat({exclude:true});
}
export class ChildSessions extends Map {
  constructor(){super();this.retired=new Set();this.exhausted=false}
  add(entry,leaseCount=0){
    const {id,parent,targetId,type}=entry;
    if(typeof id!=='string'||!id||id.length>256||typeof targetId!=='string'||!targetId)throw new Error('Invalid child identity.');
    const existing=this.get(id);
    if(existing){if(existing.parent===parent&&existing.targetId===targetId&&existing.type===type)return {entry:existing,duplicate:true};throw new Error('Conflicting child identity.');}
    if(!['iframe','worker'].includes(type))throw new Error('Unsupported child target type.');
    if(this.exhausted||this.retired.has(JSON.stringify([id,targetId])))throw new Error('Child session is retired.');
    if(parent!==undefined&&!this.has(parent))throw new Error('Child parent is not owned.');
    const depth=parent===undefined?1:this.get(parent).depth+1;
    if(this.size>=CHILD_LIMITS.perTab||leaseCount>=CHILD_LIMITS.perLease||depth>CHILD_LIMITS.depth)throw new Error('Child session limit exceeded.');
    const added={...entry,depth,aliases:new Set()};this.set(id,added);return {entry:added,duplicate:false};
  }
  remove(id){
    if(!this.has(id))return [];
    const ids=new Set([id]);for(let changed=true;changed;){changed=false;for(const [key,entry]of this)if(ids.has(entry.parent)&&!ids.has(key)){ids.add(key);changed=true}}
    const removed=[...ids].map(key=>this.get(key)).sort((a,b)=>b.depth-a.depth);
    for(const entry of removed){this.delete(entry.id);if(this.retired.size<CHILD_LIMITS.retired)this.retired.add(JSON.stringify([entry.id,entry.targetId]));else this.exhausted=true}
    return removed;
  }
}
