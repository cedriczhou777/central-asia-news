type Row = Record<string, any>;
// Atomic in-memory store models database unique keys and conditional updates, not external calls.
export function database() {
 const rows = new Map<string,Row>();
 return { rows, from() {
  let operation='read', values:Row={}, filter:Row={}, subset:Row={}, selected=false;
  const query:any={
   insert(v:Row){operation='insert';values=v;return query;},
   update(v:Row){operation='update';values=v;return query;},
   select(){selected=true;return query;}, match(v:Row){Object.assign(filter,v);return query;},
   eq(k:string,v:unknown){filter[k]=v;return query;},is(k:string,v:unknown){filter[k]=v;return query;},single(){return query;},maybeSingle(){return query;},
   contains(k:string,v:unknown){subset[k]=v;return query;},
   then(resolve:any,reject:any){return Promise.resolve().then(()=>{
    const key=(r:Row)=>`${r.version}/${r.country}`;
    if(operation==='insert') {if(rows.has(key(values)) || [...rows.values()].some(r=>r.country===values.country && r.version.slice(0,10)===values.version.slice(0,10) && (r.state!=='failed'||r.media_id)))return {error:{code:'23505'}};rows.set(key(values),{...values});return {error:null};}
    const matches=[...rows.values()].filter(r=>Object.entries(filter).every(([k,v])=>r[k]===v || (v===null && r[k]===undefined))&&Object.entries(subset).every(([k,v])=>Object.entries(v as Row).every(([sk,sv])=>r[k]?.[sk]===sv)));
    if(operation==='update'){for(const r of matches){const next={...r,...values};const conflict=[...rows.values()].some(x=>x!==r && x.country===next.country && x.version.slice(0,10)===next.version.slice(0,10) && (x.state!=='failed'||x.media_id));if((next.state!=='failed'||next.media_id) && conflict)return {error:{code:'23505'},data:null};}for(const r of matches)Object.assign(r,values);return {error:null,data:selected?matches:null};}
    return {error:null,data:matches[0]};
   }).then(resolve,reject);}
  };return query;
 }};
}
