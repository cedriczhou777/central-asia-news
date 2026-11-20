"""Check real checkpoint times before saving; does not fetch, write news or send requests."""
import argparse,json,sys
from datetime import datetime,timezone
from pathlib import Path

def parse(value):
    if not isinstance(value,str) or not value.strip():raise ValueError('timezone-aware timestamp required')
    result=datetime.fromisoformat(value.replace('Z','+00:00'))
    if result.tzinfo is None:raise ValueError('timezone required')
    return result

def validate(data,now=None):
    now=now or datetime.now(timezone.utc);errors=[]
    try:start,end,coverage=(parse(data[k]) for k in ('windowStart','windowEnd','coverageEnd'))
    except (ValueError,KeyError,TypeError):return ['missing or invalid timezone-aware coverage/window']
    if coverage>now:errors.append('coverageEnd is in the future')
    if not start<=coverage<=end:errors.append('coverageEnd outside issue window')
    if data.get('updatedAt'):
        try:
            if parse(data['updatedAt'])>now:errors.append('updatedAt is in the future')
        except (ValueError,TypeError):errors.append('updatedAt invalid')
    if data.get('stage') in ('drafted','verified'):
        if coverage!=end:errors.append('final coverage does not reach cutoff')
        if end>now:errors.append('issue cutoff has not elapsed')
    for a in data.get('articles',[]):
        value=a.get('published_at','')
        try:published=parse(value)
        except (ValueError,TypeError):
            if str(data.get('issueDate',''))>='2026-11-17' and data.get('stage') in ('drafted','verified'):
                errors.append(str(a.get('id'))+': publication time must be a valid timezone-aware timestamp')
            elif not a.get('timeEvidence'):errors.append(str(a.get('id'))+': no publication time evidence')
            continue
        if published>now:errors.append(str(a.get('id'))+': future publication')
        if not start<=published<end:errors.append(str(a.get('id'))+': publication outside issue window')
        if published>coverage:errors.append(str(a.get('id'))+': publication later than coverageEnd')
    return errors

def selftest():
    now=parse('2026-11-12T13:10:00+08:00')
    d={'windowStart':'2026-11-12T06:00:00+08:00','windowEnd':'2026-11-13T06:00:00+08:00','coverageEnd':'2026-11-12T13:08:50+08:00','stage':'precollected','articles':[]}
    assert not validate(d,now)
    assert 'coverageEnd is in the future' in validate({**d,'coverageEnd':'2026-11-12T13:15:00+08:00'},now)
    assert 'issue cutoff has not elapsed' in validate({**d,'stage':'drafted','coverageEnd':d['windowEnd']},now)
    assert 'updatedAt is in the future' in validate({**d,'updatedAt':'2026-11-12T13:18:00+08:00'},now)
    print(json.dumps({'passed':True,'checks':['real coverage time','no future final cutoff','real update time']},ensure_ascii=False))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('input',nargs='?');p.add_argument('--selftest',action='store_true');a=p.parse_args()
    if a.selftest:selftest()
    elif a.input:
        errors=validate(json.loads(Path(a.input).read_text()));print(json.dumps({'ok':not errors,'errors':errors},ensure_ascii=False));sys.exit(bool(errors))
    else:p.error('input or --selftest required')
