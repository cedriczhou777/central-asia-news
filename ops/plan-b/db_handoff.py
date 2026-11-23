"""Generate SQL for the authorized Supabase connector. Never connects to CloudBase.
Only the coordinator executes the generated SQL. No credentials occur in SQL.
"""
import argparse,hashlib,hmac,json,os,re
from pathlib import Path
from datetime import date

def canonical(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))

def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()

def literal(value):
    return "'"+str(value).replace("'","''")+"'"

def verify_original(value):
    candidate,original=value['candidate'],value['original']
    if (candidate['id']!=original['id'] or candidate['sourceHash']!=original['sourceHash']
        or hashlib.sha256(original['text'].encode()).hexdigest()!=candidate['sourceHash']):
        raise ValueError('original_hash_mismatch')
    return True

def health_verified(value,issue):
    secret=os.environ.get('CENTRAL_ASIA_INGEST_SECRET','')
    if not secret:raise ValueError('protected_ingest_secret_missing')
    expected=hmac.new(secret.encode(),('plan-b-database-exchange-1/'+issue).encode(),hashlib.sha256).hexdigest()
    activation=value.get('activation',{})
    return (hmac.compare_digest(expected,str(value.get('credentialProof','')))
        and activation.get('enabled') is True and activation.get('admitted') is True
        and activation.get('firstIssue')=='2026-11-24'
        and value.get('registration',{}).get('registered') is True
        and value.get('credentialConfiguration',{}).get('planBMatchesIngest') is True)

def sql(view,issue,country=None,phase='preview',ids=(),document=None):
    if date.fromisoformat(issue).isoformat()!=issue:raise ValueError('invalid_issue')
    if country not in (None,'kz','uz','kg','tj','az'):raise ValueError('invalid_country')
    scope='issue_date='+literal(issue)
    if country:scope+=' and country='+literal(country)
    if view=='health':return f"select payload,updated_at from public.plan_b_exchange where {scope} and country='global' and kind='health' and record_key='latest';"
    if view=='status':return f"select country,step,state,attempt,updated_at,receipt from public.plan_b_daily where {scope} order by country,step;"
    if not country:raise ValueError('country_required')
    if view=='manifest':
        if phase not in ('preview','final'):raise ValueError('invalid_phase')
        return f"select e.payload,d.state,d.attempt,d.receipt->'workCheckpoint' as checkpoint from public.plan_b_exchange e left join public.plan_b_daily d on d.issue_date=e.issue_date and d.country=e.country and d.step=e.record_key where e.{scope.replace(' and country=',' and e.country=')} and e.kind='manifest' and e.record_key={literal(phase)};"
    if view=='originals':
        if not 1<=len(ids)<=5 or len(set(ids))!=len(ids) or any(not re.fullmatch(r'[A-Za-z0-9_-]{1,96}/[a-f0-9]{64}/[a-f0-9]{64}',v)for v in ids):raise ValueError('one_to_five_id_hash_revision_keys_required')
        return f"select record_key,content_hash,payload from public.plan_b_exchange where {scope} and kind='original' and record_key in ({','.join(map(literal,ids))});"
    if view in ('word','commands'):
        if view=='word':
            if not ids:return f"select record_key,payload-'base64' as metadata from public.plan_b_exchange where {scope} and kind='word' order by created_at desc limit 1;"
            if not 1<=len(ids)<=5 or any(not re.fullmatch(r'[a-f0-9]{64}/\d{5}',v)for v in ids):raise ValueError('one_to_five_word_parts_required')
            return f"select record_key,payload from public.plan_b_exchange where {scope} and kind='word' and record_key in ({','.join(map(literal,ids))}) order by record_key;"
        condition="kind='word'" if view=='word' else "kind in ('checkpoint','submission')"
        return f"select record_key,content_hash,payload,state,attempts,result,updated_at from public.plan_b_exchange where {scope} and {condition} order by created_at desc limit 5;"
    if view not in ('checkpoint','submit') or not isinstance(document,dict):raise ValueError('invalid_command')
    if view=='checkpoint':
        if document.get('checkpointHash')!=digest(document.get('document')):raise ValueError('checkpoint_hash_mismatch')
    else:
        review=document.get('review',{})
        if not isinstance(review.get('candidateDecisions'),dict) or not document.get('finalHash'):raise ValueError('signed_evidence_required')
    kind='checkpoint' if view=='checkpoint' else 'submission';key=digest(document)
    return f"insert into public.plan_b_exchange(issue_date,country,kind,record_key,content_hash,payload,state) values ({literal(issue)},{literal(country)},{literal(kind)},{literal(key)},{literal(key)},{literal(canonical(document))}::jsonb,'queued') on conflict do nothing; select record_key,state,attempts,result from public.plan_b_exchange where {scope} and kind={literal(kind)} and record_key={literal(key)};"

def main():
    p=argparse.ArgumentParser();p.add_argument('view',choices=['health','status','manifest','originals','checkpoint','submit','commands','word','verify-health','verify-original'])
    p.add_argument('--issue',required=True);p.add_argument('--country');p.add_argument('--phase',default='preview');p.add_argument('--ids',nargs='*',default=[]);p.add_argument('--document',type=Path)
    a=p.parse_args();body=json.loads(a.document.read_bytes())if a.document else None
    if a.view=='verify-health':print(json.dumps({'verified':health_verified(body,a.issue)}))
    elif a.view=='verify-original':print(json.dumps({'verified':verify_original(body)}))
    else:print(sql(a.view,a.issue,a.country,a.phase,a.ids,body))

if __name__=='__main__':main()
