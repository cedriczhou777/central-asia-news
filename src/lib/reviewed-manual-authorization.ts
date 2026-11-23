import {getSupabaseClient} from '../storage/database/supabase-client';
import {canonicalJson,sha256} from './plan-b-handoff';

export function validManualGrant(grant:Record<string,unknown>,created:string,issue:string,version:string,hash:string,countries:readonly string[],now=Date.now()){
  const expires=Date.parse(String(grant.expiresAt));const start=Date.parse(created);
  return grant.issue===issue&&grant.version===version&&grant.contentHash===hash
    && typeof grant.issuedBy==='string'&&grant.issuedBy.trim().length>0
    && typeof grant.reason==='string'&&grant.reason.trim().length>=8
    && Array.isArray(grant.countries)&&grant.countries.length>0
    && grant.countries.every(c=>['kz','uz','kg','tj','az'].includes(c))
    && countries.every(c=>(grant.countries as unknown[]).includes(c))
    && Number.isFinite(start)&&start<=now&&expires>now&&expires-start<=24*60*60_000;
}

/** Owner-created, private, exact-issue/exact-content authorization; never a blanket bypass. */
export async function manualAuthorizationAllows(req:Request,issue:string,version:string,hash:string,countries:readonly string[],action:string){
  const id=req.headers.get('x-manual-authorization');
  if(!id||!/^[A-Za-z0-9_-]{16,96}$/.test(id))return false;
  const sb=getSupabaseClient();const {data,error}=await sb.from('plan_b_exchange').select('payload,content_hash,created_at,state')
    .eq('issue_date',issue).eq('country','global').eq('kind','manual_authorization').eq('record_key',id).maybeSingle();
  if(error||!data||data.state!=='available'||data.content_hash!==sha256(canonicalJson(data.payload))
      ||!validManualGrant(data.payload,data.created_at,issue,version,hash,countries))return false;
  const payload={authorizationId:id,issue,version,contentHash:hash,countries,action};
  const audit=await sb.from('plan_b_exchange').upsert({issue_date:issue,country:'global',kind:'manual_use',
    record_key:`${id}/${action}`,content_hash:sha256(canonicalJson(payload)),payload,state:'available'},
    {onConflict:'issue_date,country,kind,record_key',ignoreDuplicates:true});
  return !audit.error;
}
