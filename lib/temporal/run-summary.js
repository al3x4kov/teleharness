// FEAT-19.14. Per-run summary for the run list: one status kind the UI can
// render (icon + text), the current step and whether the owner must decide.
// describe() goes through a small cache: closed runs never change, running
// ones are re-read after ttlMs; a failed read is «unavailable», never «running».
const FINAL={COMPLETED:"ok",FAILED:"err",TIMED_OUT:"err",CANCELED:"cancel",TERMINATED:"term",CONTINUED_AS_NEW:"ok"};

export function summarizeRun(detail,steps=[]) {
  const base={stepsTotal:steps.length,current:null,waiting:false};
  if(!detail) return {...base,kind:"unavailable",status:"UNAVAILABLE"};
  const state=detail.state??{};
  const st=state.steps??{};
  const out={...base,status:detail.status,startTime:detail.startTime??null,closeTime:detail.closeTime??null,
    paused:!!state.paused,waitReasons:state.waitReasons??{}};
  const at=id=>{const i=steps.findIndex(s=>s.id===id);return i<0?null:{id,name:steps[i].name||id,type:steps[i].type,index:i+1};};
  const pending=(state.pending??[]).filter(Boolean);
  const active=steps.find(s=>st[s.id]==="quota_wait")??steps.find(s=>pending.includes(s.id))??steps.find(s=>st[s.id]==="running");
  out.current=active?at(active.id):null;
  out.done=steps.filter(s=>st[s.id]==="completed").length;
  if(detail.status!=="RUNNING"){
    const rejected=steps.find(s=>st[s.id]==="rejected");
    out.kind=rejected?"rejected":(FINAL[detail.status]??"unavailable");
    if(rejected)out.current=at(rejected.id);
    return out;
  }
  if(out.paused) out.kind="paused";
  else if(pending.length){out.kind="wait";out.waiting=true;}
  else if(Object.values(st).includes("quota_wait")) out.kind="quota";
  else out.kind="run";
  return out;
}

export function runSummaryCache(describe,{ttlMs=3000,now=Date.now}={}) {
  const cache=new Map();
  async function read(id){
    const hit=cache.get(id);
    if(hit&&(hit.final||now()-hit.at<ttlMs)) return hit.value;
    let value=null;
    try{value=await describe(id);}catch{value=null;}
    cache.set(id,{at:now(),value,final:!!value&&value.status!=="RUNNING"});
    if(cache.size>2000) cache.delete(cache.keys().next().value);
    return value;
  }
  async function many(ids,limit=6){
    const out=new Array(ids.length);let next=0;
    await Promise.all(Array.from({length:Math.min(limit,ids.length)},async()=>{while(next<ids.length){const i=next++;out[i]=await read(ids[i]);}}));
    return out;
  }
  return {describe:read,many};
}
