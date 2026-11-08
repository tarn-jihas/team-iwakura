#!/usr/bin/env python3
"""Offline, stateful, deterministic mock of a Reconcile read/approve/fix/verify loop.
No third-party service is contacted. The optional HTTP server binds 127.0.0.1.
"""
from __future__ import annotations
import argparse
from copy import deepcopy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import mimetypes
import os
from decimal import Decimal, DecimalException
from pathlib import Path
from threading import RLock
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import NAMESPACE_URL, uuid5
import paid_access
from collector_sdk import CollectorAuthError

HERE = Path(__file__).resolve().parent
STATE = HERE / 'runtime' / 'state.json'
EVAL = HERE / '_evaluation' / 'oracle.json'
REFERENCE = HERE / 'reference'
# Static UI folder. Default: the original string-template UI. RECONCILE_STATIC=web serves the React build (Reconcile/web).
STATIC = HERE.parent / 'Reconcile' / {'web': 'web'}.get(os.environ.get('RECONCILE_STATIC', ''), 'dist')
ID = 'mock-run-20261107'
APP = 'mock-lumen'
T0 = 1794042000  # fixed seconds, not wall clock
STATE_LOCK = RLock()

def dec(v):
    if isinstance(v, bool): raise ValueError('Money must be a finite decimal amount')
    try: result = Decimal(str(v))
    except Exception as exc: raise ValueError('Money must be a finite decimal amount') from exc
    if not result.is_finite(): raise ValueError('Money must be a finite decimal amount')
    return result

def amount(v):
    try: return format(dec(v).quantize(Decimal('0.01')), '.2f')
    except DecimalException as exc: raise ValueError('Money amount out of range') from exc
def uid(s): return str(uuid5(NAMESPACE_URL, 'reconcile-mock-20261107/'+s))
def canon(v): return json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':'))
def hashv(v): return hashlib.sha256(canon(v).encode()).hexdigest()
def read(): return json.loads(STATE.read_text())
def save(s):
    STATE.parent.mkdir(parents=True,exist_ok=True)
    p=STATE.with_suffix('.tmp')
    p.write_text(json.dumps(s,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
    p.replace(STATE)

def commit(target,updated):
    save(updated)
    target.clear();target.update(updated)

def valid_text(value,label,limit=256):
    if not isinstance(value,str) or not value.strip() or len(value)>limit:
        raise ValueError('Invalid '+label)
    return value.strip()

def selected_ids(ids):
    if not isinstance(ids,list) or not ids or any(not isinstance(x,str) or not x for x in ids):
        raise ValueError('ids must be a non-empty list of group classes')
    if len(set(ids))!=len(ids): raise ValueError('Duplicate group class')
    return ids

def transaction_key(tx,user,env,cur): return (tx,user,env,cur)

def event_class(s,e):
    p=e['properties'];name=e['event']
    if name=='reconcile_correction':return 'correction'
    if name in s['mappings']:return s['mappings'][name]
    explicit=p.get('event_class',p.get('reconcile_event_class'))
    return explicit if explicit in ('purchase','refund') else None

def visible_rows(s): return [it['payload'] for it in s['mixpanel'] if it['visible_at']<=s['clock']]
def pending_rows(s): return [it for it in s['mixpanel'] if it['visible_at']>s['clock']]

def seed():
    s={'manifest':{'run_id':ID,'seed':20261107,'mode':'FULL_MOCK','source_provenance':'synthetic','clock_utc_epoch_seconds':T0,'currency_aggregation':'per_currency_only','environment':'Production','app':APP,'project':'mock-mixpanel-eu','region':'EU','project_timezone':'America/New_York','complete_account_registry':True,'source_amount_authority':'synthetic Adapty-shaped event log; NOT GET /profile/'},'clock':0,'source':[],'mixpanel':[],'mappings':{'subscription_started':'purchase','subscription_refunded':'refund'},'approvals':{},'actions':{},'journal':[],'history':[],'history_seq':0}
    def src(tx,usr,cur,pr,kind='purchase',env='Production'):
        iso='2026-11-07T09:00:00Z'
        d={'profile_id':uid('profile/'+usr),'customer_user_id':usr,'event_type':('subscription_refunded' if kind=='refund' else 'subscription_started'),'event_datetime':iso,'event_properties':{'store':'play_store','environment':env,'currency':cur,'price_local':float(pr),'price_usd':float(dec(pr)*(dec('1.00') if cur=='USD' else dec('1.10'))),'transaction_id':tx,'original_transaction_id':tx,'vendor_product_id':'mock.monthly','profile_event_id':uid('source/'+tx+'/'+kind),'purchase_date':iso},'event_api_version':1}
        s['source'].append(d);return d
    def mp(source,name=None,price=None,insert=None):
        p=source['event_properties'];usr=source['customer_user_id'];kind='refund' if source['event_type']=='subscription_refunded' else 'purchase'
        v=dec(price if price is not None else p['price_local'])
        event={'event':name or source['event_type'],'properties':{'distinct_id':usr,'time':T0+len(s['mixpanel']),'$insert_id':insert or uid('mp/'+p['transaction_id']+'/'+kind+'/'+str(len(s['mixpanel']))),'transaction_id':p['transaction_id'],'original_transaction_id':p['original_transaction_id'],'currency':p['currency'],'price_local':amount(v),'environment':'Production','store':'play_store'}}
        s['mixpanel'].append({'payload':event,'visible_at':0,'receipt':{'http_status':200,'simulated':True}})
        return event
    src('txn_missing_purchase','u00001','USD','9.99')
    purchase=src('txn_missing_refund','u00002','USD','6.99');mp(purchase)
    src('txn_missing_refund','u00002','USD','6.99','refund')
    dupe=src('txn_duplicate','u00003','USD','12.99');mp(dupe);mp(dupe)
    mismatch=src('txn_price','u00004','EUR','9.99');mp(mismatch,price='999.00')
    rename=src('txn_renamed','u00005','EUR','14.99');mp(rename,name='premium_paid_v2')
    healthy_usd=src('txn_healthy_usd','u00006','USD','6.99');mp(healthy_usd)
    healthy_eur=src('txn_healthy_eur','u00007','EUR','6.99');mp(healthy_eur)
    src('txn_sandbox','u00008','USD','4.99',env='Sandbox')
    ghost={'event':'subscription_started','properties':{'distinct_id':'u00009','time':T0+9,'$insert_id':uid('ghost'),'transaction_id':'txn_ghost','original_transaction_id':'txn_ghost','currency':'USD','price_local':'11.98','environment':'Production','store':'play_store'}}
    s['mixpanel'].append({'payload':ghost,'visible_at':0,'receipt':{'http_status':200,'simulated':True}})
    s['journal'].append({'type':'SEEDED','run_id':ID,'clock':0,'source_events':len(s['source']),'raw_mp_events':len(s['mixpanel'])})
    save(s)
    EVAL.parent.mkdir(parents=True,exist_ok=True)
    EVAL.write_text(json.dumps({'private_fixture_oracle_not_read_by_engine':True,'expected_before_gap':{'USD':'21.97','EUR':'989.01'},'expected_after_gap':{'USD':'11.98','EUR':'0.00'},'expected_initial_groups':['MISSING_IN_MIXPANEL','PRICE_MISMATCH','DUPLICATE_IN_MIXPANEL','UNMAPPED_EVENT_NAME','EXTRA_IN_MIXPANEL','SANDBOX_EXPECTED']},indent=2)+'\n')
    return s

def source_events(s):
    # A real Get profile response does not enumerate transaction amounts.
    return [e for e in s['source'] if e['event_properties']['environment']=='Production']

def source_kind(e): return 'refund' if e['event_type']=='subscription_refunded' else 'purchase'
def source_identity(e):
    p=e['event_properties']
    return transaction_key(p['transaction_id'],e['customer_user_id'],p['environment'],p['currency'])
def destination_identity(e):
    p=e['properties']
    return transaction_key(p['transaction_id'],p['distinct_id'],p['environment'],p['currency'])

def get_money(e):
    if e['event_type']=='subscription_refunded':return -dec(e['event_properties']['price_local'])
    return dec(e['event_properties']['price_local'])

def mp_money(s,e,kind=None):
    p=e['properties'];v=dec(p['price_local'])
    return -abs(v) if (kind or event_class(s,e))=='refund' else v

def make_find(cls,tx,kind,cur,diff,user,evidence,env='Production',evidence_id=''):
    finding_id=f'{cls}|{tx}|{kind}|{user}|{env}|{cur}|{ID}|{APP}'
    if evidence_id:finding_id+='|'+evidence_id
    return {'id':finding_id,'cls':cls,'txn':tx,'user':user,'event_class':kind,'currency':cur,'environment':env,'delta':amount(diff),'evidence':evidence,'note':'Synthetic observations; no provider calls', 'provenance':'FULL_MOCK'}

def normalized_destination(s):
    # Keep raw records, but query-time dedup by the fixture's same-tuple policy.
    seen={}
    for e in visible_rows(s):
        p=e['properties'];key=(e['event'],p.get('distinct_id'),p.get('time'),p.get('$insert_id'))
        seen[key]=e
    return list(seen.values())

def destination_assignments(s,normalized):
    by_identity={}
    for e in normalized: by_identity.setdefault(destination_identity(e),[]).append(e)
    source_kinds={}
    for e in source_events(s): source_kinds.setdefault(source_identity(e),set()).add(source_kind(e))
    assigned={};ambiguous=set()
    for ident,rows in by_identity.items():
        candidates=source_kinds.get(ident,set())
        known={event_class(s,e) for e in rows if event_class(s,e) in ('purchase','refund')}
        unknown=[e for e in rows if event_class(s,e) is None]
        remaining=candidates-known
        if unknown and len(remaining)==1:
            for e in unknown: assigned[id(e)]=next(iter(remaining))
        elif unknown and len(candidates)==1:
            for e in unknown: assigned[id(e)]=next(iter(candidates))
        elif unknown and candidates:
            ambiguous.update(ident for _ in unknown)
    return by_identity,assigned,ambiguous

def plan_payload(s,cls,f,evidence_version=None):
    source=next((e for e in s['source'] if source_identity(e)==transaction_key(f['txn'],f['user'],f['environment'],f['currency']) and source_kind(e)==f['event_class']),None)
    if source is None: raise ValueError('Missing source for '+f['id'])
    sp=source['event_properties'];amt=get_money(source)
    if cls=='MISSING_IN_MIXPANEL':
        event=source['event_type'];sum_amt=amt;corrects=None
    else:
        event='reconcile_correction';sum_amt=-dec(f['delta']);corrects=f['event_class']
    version=evidence_version or finding_evidence_hash(s,cls,[f])
    props={'distinct_id':f['user'],'time':T0+1000,'$insert_id':uid('apply/'+f['id']+'/'+f['delta']+'/'+version),'transaction_id':f['txn'],'original_transaction_id':sp['original_transaction_id'],'currency':f['currency'],'price_local':amount(sum_amt),'environment':f['environment'],'store':'play_store','reconcile_run_id':ID}
    if corrects: props.update({'corrects_class':cls,'corrects_event_class':corrects,'reason':'synthetic approved correction'})
    return {'event':event,'properties':props}

def finding_evidence(s,cls,items):
    txs={f['txn'] for f in items};users={f['user'] for f in items}
    source=[e for e in s['source'] if e['event_properties']['transaction_id'] in txs and e['customer_user_id'] in users]
    dest=[e for e in s['mixpanel'] if e['payload']['properties'].get('transaction_id') in txs and e['payload']['properties'].get('distinct_id') in users]
    names={e['payload']['event'] for e in dest}
    names.update(e['event_type'] for e in source)
    return {'run':s['manifest']['run_id'],'app':s['manifest']['app'],'class':cls,'findings':items,'source':source,'destination':dest,'mappings':{name:s['mappings'].get(name) for name in sorted(names)}}

def finding_evidence_hash(s,cls,items): return hashv(finding_evidence(s,cls,items))

def group_hash(s,cls,items,evidence_version=None):
    version=evidence_version or finding_evidence_hash(s,cls,items)
    plan=[plan_payload(s,cls,f,version) for f in items] if cls in ('MISSING_IN_MIXPANEL','PRICE_MISMATCH','DUPLICATE_IN_MIXPANEL') else []
    return hashv({'evidence_hash':version,'plan':plan})

def detect(s):
    normalized=normalized_destination(s);by_identity,assigned,ambiguous=destination_assignments(s,normalized);findings=[]
    by_tx={}
    for e in normalized: by_tx.setdefault(e['properties']['transaction_id'],[]).append(e)
    source_by_identity={}
    for e in source_events(s): source_by_identity.setdefault(source_identity(e),[]).append(e)
    for ident,source_group in source_by_identity.items():
        tx,user,env,cur=ident
        related=by_tx.get(tx,[])
        kinds=[source_kind(source) for source in source_group]
        if len(kinds)!=len(set(kinds)):
            findings.append(make_find('AMBIGUOUS_IDENTITY',tx,'unknown',cur,0,user,'Multiple source events share the same transaction, user, environment and currency; automatic repair blocked',env))
            continue
        if any(destination_identity(x)[1]!=user or destination_identity(x)[2]!=env for x in related):
            findings.append(make_find('AMBIGUOUS_IDENTITY',tx,'unknown',cur,0,user,'Transaction exists under another user or environment; automatic repair blocked',env))
            continue
        if any(destination_identity(x)[3]!=cur for x in related):
            findings.append(make_find('CURRENCY_MISMATCH',tx,'unknown',cur,0,user,'Transaction currency differs from source; automatic repair blocked',env))
            continue
        if ident in ambiguous:
            findings.append(make_find('AMBIGUOUS_EVENT_CLASS',tx,'unknown',cur,0,user,'Unmapped event could represent multiple event classes; automatic repair blocked',env))
            continue
        exact=by_identity.get(ident,[])
        for source in source_group:
            kind=source_kind(source);expected=get_money(source)
            kind_rows=[x for x in exact if event_class(s,x)==kind or assigned.get(id(x))==kind]
            unknown=[x for x in exact if event_class(s,x) is None and assigned.get(id(x))==kind]
            if unknown:
                findings.append(make_find('UNMAPPED_EVENT_NAME',tx,kind,cur,0,user,'Known transaction and identity present under an unmapped event name; do not backfill',env))
                continue
            if not kind_rows:
                findings.append(make_find('MISSING_IN_MIXPANEL',tx,kind,cur,-expected,user,'Source has event; destination lacks matching class in declared scope',env))
                continue
            actual=sum((mp_money(s,x,assigned.get(id(x))) for x in kind_rows if event_class(s,x)!='correction'),Decimal(0))
            actual+=sum((dec(x['properties']['price_local']) for x in exact if event_class(s,x)=='correction' and x['properties'].get('corrects_event_class')==kind),Decimal(0))
            if amount(actual)!=amount(expected):
                typ='DUPLICATE_IN_MIXPANEL' if len([x for x in kind_rows if event_class(s,x)==kind])>1 else 'PRICE_MISMATCH'
                findings.append(make_find(typ,tx,kind,cur,actual-expected,user,f'{len(kind_rows)} effective destination events, source={amount(expected)}, destination+corrections={amount(actual)}',env))
    for e in s['source']:
        if e['event_properties']['environment']=='Sandbox':
            p=e['event_properties'];findings.append(make_find('SANDBOX_EXPECTED',p['transaction_id'],'purchase',p['currency'],0,e['customer_user_id'],'Sandbox excluded by metric contract','Sandbox',p['profile_event_id']))
    production_ids={e['event_properties']['transaction_id'] for e in source_events(s)}
    for tx,rows in by_tx.items():
        if tx not in production_ids:
            for e in rows:
                p=e['properties']
                if p['environment']!='Production': continue
                if event_class(s,e)=='correction': continue
                kind=event_class(s,e) or assigned.get(id(e)) or 'purchase'
                findings.append(make_find('EXTRA_IN_MIXPANEL',tx,kind,p['currency'],mp_money(s,e),p['distinct_id'],'Destination event without source transaction in known production population',p['environment'],p['$insert_id']))
    totals={};src_totals={}
    for e in source_events(s):
        cur=e['event_properties']['currency'];src_totals[cur]=src_totals.get(cur,Decimal(0))+get_money(e)
    for e in normalized:
        p=e['properties']
        if p['environment']!='Production': continue
        cur=p['currency'];totals[cur]=totals.get(cur,Decimal(0))+mp_money(s,e,assigned.get(id(e)))
    gaps={cur:amount(totals.get(cur,Decimal(0))-src_totals.get(cur,Decimal(0))) for cur in sorted(set(src_totals)|set(totals))}
    groups={}
    for f in findings:groups.setdefault(f['cls'],[]).append(f)
    actions={'MISSING_IN_MIXPANEL':'backfill_mixpanel','PRICE_MISMATCH':'post_correction','DUPLICATE_IN_MIXPANEL':'post_correction','UNMAPPED_EVENT_NAME':'map_event_name','EXTRA_IN_MIXPANEL':'investigate','SANDBOX_EXPECTED':'none','AMBIGUOUS_IDENTITY':'investigate','CURRENCY_MISMATCH':'investigate','AMBIGUOUS_EVENT_CLASS':'investigate'}
    out=[]
    for cls,items in sorted(groups.items()):
        money={}
        for f in items:money[f['currency']]=money.get(f['currency'],Decimal(0))+dec(f['delta'])
        writes=cls in ('MISSING_IN_MIXPANEL','PRICE_MISMATCH','DUPLICATE_IN_MIXPANEL')
        state=group_state(s,cls,items)
        version=finding_evidence_hash(s,cls,items)
        out.append({'cls':cls,'action':actions[cls],'writes':writes,'confidence':'deterministic/mock','risk':'requires preview and approval' if writes else 'none','why':f'{len(items)} synthetic finding(s); deterministic rule','delta':{c:amount(v) for c,v in money.items()},'users':sorted(set(f['user'] for f in items)),'findings':items,'evidence_hash':version,'group_hash':group_hash(s,cls,items,version),'state':state})
    group_states={cls:group_state(s,cls,groups.get(cls,[])) for cls in ('MISSING_IN_MIXPANEL','PRICE_MISMATCH','DUPLICATE_IN_MIXPANEL','UNMAPPED_EVENT_NAME','EXTRA_IN_MIXPANEL','SANDBOX_EXPECTED','AMBIGUOUS_IDENTITY','CURRENCY_MISMATCH','AMBIGUOUS_EVENT_CLASS')}
    pending=len(pending_rows(s))
    verify_status=verification(s)['status']
    active=[g for g in out if g['cls'] not in ('EXTRA_IN_MIXPANEL','SANDBOX_EXPECTED')]
    if pending: verify_status='pending_visibility'
    elif s.get('actions') and active: verify_status='open_findings'
    return {'run':s['manifest']['run_id'],'mode':'FULL_MOCK','manifest':s['manifest'],'clock':s['clock'],'source_provenance':'synthetic','destination_provenance':'synthetic/stateful','source_totals':{c:amount(v) for c,v in src_totals.items()},'destination_effective_totals':{c:amount(v) for c,v in totals.items()},'gap':gaps,'groups':out,'group_states':group_states,'raw_event_count':len(visible_rows(s)),'query_event_count':len(normalized),'pending_count':pending,'approval_count':len(s['approvals']),'action_count':len(s['actions']),'verification_status':verify_status}

def group_state(s,cls,items):
    if cls=='EXTRA_IN_MIXPANEL': return 'manual'
    if cls=='SANDBOX_EXPECTED': return 'expected'
    if cls=='UNMAPPED_EVENT_NAME':
        mapped={j.get('event') for j in s['journal'] if j.get('type')=='MAPPING_APPROVED' and s['mappings'].get(j.get('event')) in ('purchase','refund')}
        present={e['event'] for e in visible_rows(s)}
        return 'mapped' if not items and mapped&present else 'open'
    if cls not in ('MISSING_IN_MIXPANEL','PRICE_MISMATCH','DUPLICATE_IN_MIXPANEL'):
        return 'manual' if items else 'open'
    if not items:
        has_action=any(a['group']==cls for a in s['actions'].values())
        return 'verified' if has_action else 'open'
    if any(a['group']==cls and a.get('visible_at_tick',0)>s['clock'] for a in s['actions'].values()): return 'pending'
    approval=s['approvals'].get(cls)
    if approval and approval.get('group_hash')==group_hash(s,cls,items): return 'approved'
    return 'open'

def preview(s,ids=None):
    r=detect(s)
    groups=[g for g in r['groups'] if g['writes'] and (ids is None or g['cls'] in ids)]
    return {'run':r['run'],'mode':'FULL_MOCK','groups':[{'class':g['cls'],'action':g['action'],'finding_ids':[f['id'] for f in g['findings']],'expected_signed_gap_change':{c:amount(-dec(v)) for c,v in g['delta'].items()},'approval_hash':g['group_hash'],'group_hash':g['group_hash'],'evidence_hash':g['evidence_hash'],'row_count':len(g['findings']),'payloads':[plan_payload(s,g['cls'],f,g['evidence_hash']) for f in g['findings']],'source_data':'synthetic'} for g in groups], 'notes':'Preview is deterministic and cannot call any real provider'}

def approve(s,ids,actor='demo-operator',hashes=None):
    ids=selected_ids(ids);actor=valid_text(actor,'actor',100)
    if pending_rows(s): raise ValueError('Pending writes must be visible before approval')
    report=detect(s);groups={g['cls']:g for g in report['groups']};selected=[]
    if hashes is not None and not isinstance(hashes,dict): raise ValueError('hashes must be an object')
    for cls in ids:
        g=groups.get(cls)
        if not g or not g['writes']: raise ValueError('Not an eligible repair group: '+cls)
        if hashes is not None and hashes.get(cls)!=g['group_hash']: raise ValueError('Stale approval hash: '+cls)
        selected.append(g)
    updated=deepcopy(s)
    for g in selected:
        cls=g['cls'];updated['approvals'][cls]={'actor':actor,'group_hash':g['group_hash'],'evidence_hash':g['evidence_hash'],'approved_at_tick':s['clock'],'findings':[f['id'] for f in g['findings']]}
        updated['journal'].append({'type':'APPROVAL','cls':cls,'actor':actor,'tick':s['clock'],'hash':g['group_hash']})
    commit(s,updated);return {'approved':list(ids)}

def do_apply(s,ids):
    ids=selected_ids(ids);report=detect(s);groups={g['cls']:g for g in report['groups']};plans=[];new_count=0
    for cls in ids:
        approval=s['approvals'].get(cls)
        if not approval: raise ValueError('Approval required for '+cls)
        g=groups.get(cls)
        if not g:
            if any(a['group']==cls for a in s['actions'].values()): continue
            raise ValueError('No outstanding approved group: '+cls)
        if not g['writes']: raise ValueError('Read-only class: '+cls)
        version=approval.get('evidence_hash',g['evidence_hash'])
        pending=[]
        for f in g['findings']:
            action_id=uid('action/'+f['id']+'/'+f['delta']+'/'+version)
            if action_id not in s['actions']: pending.append((f,action_id))
        if not pending: continue
        if g['group_hash']!=approval['group_hash']: raise ValueError('Stale approval, re-run preview: '+cls)
        plans.append((cls,approval,pending))
        new_count+=len(pending)
    if new_count and pending_rows(s): raise ValueError('Pending writes must be visible before new repairs')
    if not new_count: return {'writes_accepted':0,'state':'no_op','report':report}
    updated=deepcopy(s);new=0
    for cls,approval,pending in plans:
        for f,action_id in pending:
            version=approval.get('evidence_hash',finding_evidence_hash(s,cls,groups[cls]['findings']))
            payload=plan_payload(s,cls,f,version)
            updated['mixpanel'].append({'payload':payload,'visible_at':s['clock']+1,'receipt':{'http_status':200,'accepted':1,'simulated':True}})
            updated['actions'][action_id]={'group':cls,'finding':f['id'],'txn':f['txn'],'user':f['user'],'event_class':f['event_class'],'currency':f['currency'],'environment':f['environment'],'delta':f['delta'],'evidence_hash':version,'payload_hash':hashv(payload),'insert_id':payload['properties']['$insert_id'],'accepted_at_tick':s['clock'],'visible_at_tick':s['clock']+1,'approval_actor':approval['actor']}
            updated['journal'].append({'type':'WRITE_ACCEPTED_MOCK','cls':cls,'finding':f['id'],'action_id':action_id,'tick':s['clock'],'destination_visible_at':s['clock']+1,'payload':payload})
            new+=1
    commit(s,updated)
    return {'writes_accepted':new,'state':'pending_visibility','report':detect(s)}

def map_name(s,event,cls,actor):
    event=valid_text(event,'event name',128);actor=valid_text(actor,'actor',100)
    if event=='reconcile_correction' or cls not in ('purchase','refund'):raise ValueError('Bad event class')
    if pending_rows(s): raise ValueError('Pending writes must be visible before mapping changes')
    updated=deepcopy(s);old=updated['mappings'].get(event);updated['mappings'][event]=cls
    updated['journal'].append({'type':'MAPPING_APPROVED','actor':actor,'event':event,'from':old,'to':cls,'tick':s['clock']});commit(s,updated)
    return {'event':event,'event_class':cls,'approved_by':actor}

def advance(s,n=1):
    if isinstance(n,bool) or not isinstance(n,int) or not (0<n<=100):raise ValueError('Tick must be 1..100')
    updated=deepcopy(s);updated['clock']+=n;updated['journal'].append({'type':'MOCK_CLOCK_ADVANCED','tick':updated['clock']});commit(s,updated)
    return detect(s)

def profile(s,user):
    a=[e for e in s['source'] if e['customer_user_id']==user]
    if not a:return None
    env=a[0]['event_properties']['environment'];res=sum(((dec(e['event_properties']['price_usd']) if e['event_type']!='subscription_refunded' else -dec(e['event_properties']['price_usd'])) for e in a),Decimal(0));
    return {'data':{'app_id':APP,'profile_id':a[0]['profile_id'],'customer_user_id':user,'total_revenue_usd':float(res),'timestamp':1794042000000,'custom_attributes':[{'key':'seed_source','value':'mock_first'}],'access_levels':([] if env=='Sandbox' else [{'access_level_id':'premium','store':'play_store','store_transaction_id':a[0]['event_properties']['transaction_id'],'expires_at':'2026-12-01T00:00:00Z'}]),'subscriptions':([] if env=='Sandbox' else [{'store':'play_store','store_product_id':'mock.monthly','store_transaction_id':a[0]['event_properties']['transaction_id'],'environment':env,'expires_at':'2026-12-01T00:00:00Z'}]),'non_subscriptions':[]}}

def operations(s):
    normalized=normalized_destination(s);by_identity,assigned,ambiguous=destination_assignments(s,normalized)
    pending=[item['payload'] for item in pending_rows(s)];sources={};destinations={};pending_keys=set()
    def key(tx,user,env,cur,kind):return (tx,user,env,cur,kind)
    for source in s['source']:
        p=source['event_properties'];k=key(p['transaction_id'],source['customer_user_id'],p['environment'],p['currency'],source_kind(source))
        sources[k]=sources.get(k,Decimal(0))+(get_money(source) if p['environment']=='Production' else Decimal(0))
    for e in normalized:
        p=e['properties'];kind=event_class(s,e)
        if kind=='correction':
            kind=p.get('corrects_event_class')
            if kind not in ('purchase','refund'):continue
            value=dec(p['price_local'])
        else:
            kind=kind or assigned.get(id(e)) or 'purchase';value=mp_money(s,e,kind)
        k=key(p['transaction_id'],p['distinct_id'],p['environment'],p['currency'],kind)
        if p['environment']=='Production':destinations[k]=destinations.get(k,Decimal(0))+value
    for e in pending:
        p=e['properties'];kind=event_class(s,e)
        if kind=='correction':kind=p.get('corrects_event_class')
        kind=kind or assigned.get(id(e)) or 'purchase'
        pending_keys.add(key(p.get('transaction_id'),p.get('distinct_id'),p.get('environment'),p.get('currency'),kind))
    out=[]
    for k in sources.keys()|destinations.keys():
        tx,user,env,cur,kind=k;ident=transaction_key(tx,user,env,cur);source_amount=sources.get(k,Decimal(0));destination=destinations.get(k,Decimal(0))
        related=[e for e in normalized if e['properties']['transaction_id']==tx]
        source_dupes=sum(1 for item in s['source'] if source_identity(item)==ident and source_kind(item)==kind)>1
        manual=source_dupes or any(destination_identity(e)[1]!=user or destination_identity(e)[2]!=env for e in related) or any(destination_identity(e)[3]!=cur for e in related) or ident in ambiguous
        unmapped=any(event_class(s,e) is None and assigned.get(id(e))==kind and destination_identity(e)==ident for e in normalized)
        if env=='Sandbox':status='expected';source_amount=Decimal(0);destination=Decimal(0)
        elif manual or k not in sources:status='manual'
        elif k in pending_keys:status='pending'
        elif unmapped:status='unmapped'
        elif amount(destination)==amount(source_amount):
            status='verified' if any(a.get('txn')==tx and a.get('user')==user and a.get('environment')==env and a.get('currency')==cur and a.get('event_class')==kind for a in s['actions'].values()) else 'healthy'
        else:status='open'
        out.append({'txn':tx,'user':user,'event_class':kind,'currency':cur,'source_amount':amount(source_amount),'destination_amount':amount(destination),'delta':amount(destination-source_amount),'status':status,'environment':env})
    out.sort(key=lambda op:(op['txn'],op['user'],op['environment'],op['event_class'],op['currency']))
    return {'operations':out,'mode':'FULL_MOCK'}

def record_history(s,kind,report):
    updated=deepcopy(s);seq=updated.get('history_seq',0)+1;updated['history_seq']=seq
    updated.setdefault('history',[]).append({'id':f"{ID}-{kind}-{seq:06d}",'kind':kind,'tick':s['clock'],'report':report})
    updated['history']=updated['history'][-20:];commit(s,updated)
    return {'runs':list(reversed(s['history']))}

def verification(s):
    visible=visible_rows(s)
    statuses=[]
    for action_id,action in sorted(s['actions'].items()):
        payload=next((e for e in visible if e['properties'].get('$insert_id')==action.get('insert_id') and hashv(e)==action['payload_hash']),None)
        matched=payload is not None
        status='verified' if matched else ('pending_visibility' if action.get('visible_at_tick',0)>s['clock'] else 'missing_readback')
        statuses.append({'action_id':action_id,'group':action['group'],'finding':action['finding'],'status':status,'insert_id':action.get('insert_id'),'readback':payload if matched else None})
    if not s['actions']:status='not_run'
    elif any(x['status']=='pending_visibility' for x in statuses):status='pending_visibility'
    elif all(x['status']=='verified' for x in statuses):status='verified'
    else:status='readback_failed'
    return {'status':status,'tick':s['clock'],'actions':statuses}

def audit(s):
    return {'run':ID,'mode':'FULL_MOCK','manifest':s['manifest'],'journal':s['journal'],'actions':s['actions'],'approvals':s['approvals'],'verification':verification(s)}

def evidence(s,tx):
    source=[e for e in s['source'] if e['event_properties']['transaction_id']==tx]
    destination=[];pending=[];correction_receipts=[]
    for item in s['mixpanel']:
        payload=item['payload']
        if payload['properties'].get('transaction_id')!=tx:continue
        if item['visible_at']<=s['clock']:
            destination.append(payload)
            if event_class(s,payload)=='correction': correction_receipts.append({'payload':payload,'receipt':item['receipt'],'visible_at_tick':item['visible_at']})
        else: pending.append({'payload':payload,'receipt':item['receipt'],'visible_at_tick':item['visible_at']})
    return {'txn':tx,'source':source,'destination':destination,'pending_destination':pending,'correction_receipts':correction_receipts,'mode':'FULL_MOCK'}

def sample_index():
    root=REFERENCE.resolve()
    samples=[]
    if not root.is_dir():return {'samples':[]}
    for path in sorted(root.rglob('*')):
        if not path.is_file() or path.is_symlink():continue
        resolved=path.resolve()
        if not resolved.is_relative_to(root):continue
        rel=resolved.relative_to(root).as_posix()
        samples.append({'path':rel,'provider':rel.split('/',1)[0] if '/' in rel else 'reference','bytes':resolved.stat().st_size})
    return {'samples':samples}

def read_sample(name):
    if not isinstance(name,str) or not name or name.startswith('/') or '\\' in name or '\x00' in name: raise ValueError('Invalid sample path')
    parts=Path(name).parts
    if any(part in ('','.', '..') or part.startswith('.') for part in parts): raise ValueError('Invalid sample path')
    root=REFERENCE.resolve();original=root/Path(name);path=original.resolve(strict=True)
    if original.is_symlink() or not path.is_relative_to(root) or not path.is_file(): raise ValueError('Unknown sample')
    return {'path':path.relative_to(root).as_posix(),'content':path.read_text(encoding='utf-8'),'mode':'FULL_MOCK'}

def static_asset(path):
    decoded=unquote(path)
    if decoded=='/': decoded='/index.html'
    if '\x00' in decoded or '\\' in decoded:return None
    parts=Path(decoded.lstrip('/')).parts
    if not parts or any(part in ('','.', '..') or part.startswith('.') for part in parts):return None
    if any(part.lower() in ('runtime','_evaluation','.env','.openai') for part in parts):return None
    if Path(parts[-1]).suffix.lower() in ('.py','.pyc','.pyo'):return None
    root=STATIC.resolve();original=root/Path(*parts)
    try:path=original.resolve(strict=True)
    except OSError:return None
    if not path.is_relative_to(root) or not path.is_file():return None
    return path

def validate_import_event(event,manifest):
    if not isinstance(event,dict) or not isinstance(event.get('properties'),dict): raise ValueError('Every import row must be an event object')
    clean=deepcopy(event);clean['event']=valid_text(event.get('event'),'event name',128);p=event['properties'];clean_p=clean['properties']
    for name in ('distinct_id','$insert_id','transaction_id','currency','environment'):
        clean_p[name]=valid_text(p.get(name),name,256)
    if not isinstance(p['time'],int) or isinstance(p['time'],bool) or p['time']<0: raise ValueError('Invalid time')
    if p['currency'] not in ('USD','EUR'): raise ValueError('Unsupported currency for this mock project')
    if p['environment'] not in ('Production','Sandbox'): raise ValueError('Invalid environment')
    if clean['event']=='reconcile_correction' and p.get('corrects_event_class') not in ('purchase','refund'): raise ValueError('Correction requires corrects_event_class')
    for key in ('app_id','app'):
        if key in event and event[key]!=manifest['app']: raise ValueError('Wrong app for mock project')
        if key in p and p[key]!=manifest['app']: raise ValueError('Wrong app for mock project')
    if 'price_local' not in p: raise ValueError('Missing property: price_local')
    money=dec(p['price_local']);normalized=amount(money)
    if dec(normalized)!=money: raise ValueError('price_local supports two decimal places in this mock project')
    clean_p['price_local']=normalized
    return clean

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def respond(self,data,status=200,ctype='application/json'):
        raw=(data if isinstance(data,bytes) else (json.dumps(data,ensure_ascii=False,allow_nan=False,separators=(',',':'))+'\n').encode())
        self.send_response(status);self.send_header('Content-Type',ctype);self.send_header('Content-Length',str(len(raw)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(raw)
    def route(self):
        split=urlsplit(self.path);q=parse_qs(split.query,keep_blank_values=True);return split.path,q
    def do_GET(self):
        with STATE_LOCK: self._do_get()
    def _do_get(self):
        try:
            path,q=self.route()
            if path.startswith('/api/access/'):
                reads={
                    '/api/access/report':paid_access.report,
                    '/api/access/audit':paid_access.audit,
                    '/api/access/registry':paid_access.registry,
                }
                if path in reads:return self.respond(reads[path]())
                if path=='/api/access/evidence':return self.respond(paid_access.evidence(q.get('user',[''])[0]))
                if path=='/api/access/journal':
                    query={key:values[0] for key,values in q.items()}
                    if 'limit' in query:
                        try:query['limit']=int(query['limit'])
                        except ValueError:return self.respond({'error':'Invalid journal limit'},400)
                    return self.respond(paid_access.journal(query))
                return self.respond({'error':'not found'},404)
            if path=='/api/report':
                s=read()
                if q.get('run',[ID])[0]!=ID:return self.respond({'error':'unknown run'},404)
                return self.respond(detect(s))
            if path=='/api/preview':return self.respond(preview(read()))
            if path=='/api/verify':
                s=read();result=detect(s);result['verification']=verification(s);return self.respond(result)
            if path=='/api/evidence':
                s=read()
                tx=q.get('txn',[''])[0]
                return self.respond(evidence(s,tx))
            if path=='/api/audit':return self.respond(audit(read()))
            if path=='/api/manifest':return self.respond(read()['manifest'])
            if path=='/api/history':return self.respond({'runs':list(reversed(read().get('history',[])))})
            if path=='/api/operations':return self.respond(operations(read()))
            if path=='/api/samples':return self.respond(sample_index())
            if path=='/api/sample':
                try:return self.respond(read_sample(q.get('path',[''])[0]))
                except FileNotFoundError:return self.respond({'error':'unknown sample'},404)
            if path=='/mock/adapty/api/v2/server-side-api/profile/':
                s=read()
                p=profile(s,(q.get('customer_user_id') or q.get('adapty-customer-user-id') or [''])[0]);return self.respond(p,200) if p else self.respond({'error':'profile_does_not_exist'},404)
            if path=='/mock/adapty/events/export':return self.respond(('\n'.join(canon(e) for e in read()['source'])+'\n').encode(),ctype='application/x-ndjson')
            if path=='/mock/mixpanel/api/2.0/export':return self.respond(('\n'.join(canon(e) for e in visible_rows(read()))+'\n').encode(),ctype='application/x-ndjson')
            if path=='/mock/mixpanel/query':
                report=detect(read());return self.respond({'totals':report['destination_effective_totals'],'gap':report['gap'],'metric':'source-like events PLUS reconcile_correction; MOCK ONLY'})
            if path.startswith('/api/') or path.startswith('/mock/'):return self.respond({'error':'not found'},404)
            asset=static_asset(path)
            if asset is None:return self.respond({'error':'not found'},404)
            ctype=mimetypes.guess_type(asset.name)[0] or 'application/octet-stream'
            return self.respond(asset.read_bytes(),ctype=ctype)
        except paid_access.APIError as exc:return self.respond({'error':str(exc)},exc.status)
        except (ValueError,KeyError,TypeError) as exc:return self.respond({'error':str(exc)},400)
        except Exception:return self.respond({'error':'internal error'},500)
    def write_origin_ok(self):
        raw=self.headers.get('Host','')
        try:host=urlsplit('//'+raw)
        except ValueError:return False
        if not host.hostname or host.username or host.password or host.path or host.query or host.fragment:return False
        try:host_port=host.port or 80
        except ValueError:return False
        name=host.hostname.lower().rstrip('.')
        try:loopback=name=='localhost' or ipaddress.ip_address(name).is_loopback
        except ValueError:loopback=False
        if not loopback or host_port!=self.server.server_port:return False
        origin=self.headers.get('Origin')
        if origin is None:return True
        try:parsed=urlsplit(origin)
        except ValueError:return False
        if parsed.scheme!='http' or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('','/') or parsed.query or parsed.fragment:return False
        try:origin_port=parsed.port or 80
        except ValueError:return False
        return parsed.hostname.lower().rstrip('.')==name and origin_port==host_port
    def do_POST(self):
        with STATE_LOCK: self._do_post()
    def _do_post(self):
        try:
            if not self.write_origin_ok():return self.respond({'error':'loopback same-origin request required'},403)
            content_type=self.headers.get('Content-Type','').split(';',1)[0].strip().lower()
            if content_type!='application/json':return self.respond({'error':'Content-Type must be application/json'},415)
            path,q=self.route()
            try:length=int(self.headers.get('Content-Length','-1'))
            except ValueError:return self.respond({'error':'Invalid Content-Length'},400)
            if length<0:return self.respond({'error':'Content-Length required'},400)
            if length>1024*1024:return self.respond({'error':'body too large'},413)
            raw=self.rfile.read(length)
            def bad_constant(_):raise ValueError('Invalid JSON number')
            body=json.loads(raw or b'{}',parse_constant=bad_constant)
            if path.startswith('/api/access/') or path in ('/api/collector/events','/mock/lumen/export'):
                if not isinstance(body,dict):return self.respond({'error':'Object required'},400)
                mutations={
                    '/api/access/detect':paid_access.detect,
                    '/api/access/preview':paid_access.preview,
                    '/api/access/approve':paid_access.approve,
                    '/api/access/apply':paid_access.apply,
                    '/api/access/verify':paid_access.verify,
                    '/api/access/demo':paid_access.demo,
                }
                if path in mutations:return self.respond(mutations[path](body))
                if path=='/api/collector/events':return self.respond(paid_access.collector(body,self.headers.get('X-Reconcile-Signature','')))
                if path=='/mock/lumen/export':
                    if body.get('feature','premium_export')!='premium_export':return self.respond({'error':'Unsupported feature'},400)
                    result=paid_access.gate(body.get('user_id',''),initiator='customer_demo')
                    return self.respond(result,200 if result.get('allowed') else 403)
                return self.respond({'error':'not found'},404)
            s=read()
            if path=='/api/reset':
                if not isinstance(body,dict):return self.respond({'error':'Object required'},400)
                baseline=seed();return self.respond({'mode':'FULL_MOCK','manifest':baseline['manifest'],'report':detect(baseline)})
            if path in ('/api/detect','/api/verify'):
                if not isinstance(body,dict):return self.respond({'error':'Object required'},400)
                report=detect(s)
                if path=='/api/verify':report['verification']=verification(s)
                record_history(s,'detect' if path.endswith('detect') else 'verify',report)
                return self.respond(report)
            if path=='/api/approve':
                if not isinstance(body,dict):return self.respond({'error':'Object required'},400)
                if body.get('run',ID)!=ID:return self.respond({'error':'unknown run'},404)
                hashes=body.get('hashes',body.get('group_hashes'))
                return self.respond(approve(s,body['ids'],body.get('actor','demo-operator'),hashes))
            if path=='/api/apply':
                if not isinstance(body,dict):return self.respond({'error':'Object required'},400)
                if body.get('run',ID)!=ID:return self.respond({'error':'unknown run'},404)
                return self.respond(do_apply(s,body['ids']))
            if path=='/api/map':
                if not isinstance(body,dict):return self.respond({'error':'Object required'},400)
                return self.respond(map_name(s,body['event'],body['cls'],body.get('actor','demo-operator')))
            if path=='/api/reset-mappings':
                if not isinstance(body,dict):return self.respond({'error':'Object required'},400)
                if pending_rows(s):raise ValueError('Pending writes must be visible before mapping changes')
                updated=deepcopy(s);updated['mappings']={'subscription_started':'purchase','subscription_refunded':'refund'}
                updated['journal'].append({'type':'MAPPING_RESET','actor':valid_text(body.get('actor','demo-operator'),'actor',100),'tick':s['clock']});commit(s,updated)
                return self.respond({'mappings':s['mappings'],'mode':'FULL_MOCK'})
            if path=='/api/advance-clock':
                if not isinstance(body,dict):return self.respond({'error':'Object required'},400)
                ticks=body.get('ticks',1)
                if isinstance(ticks,str) and ticks.isdigit():ticks=int(ticks)
                return self.respond(advance(s,ticks))
            if path=='/mock/mixpanel/import':
                if not isinstance(body,list):return self.respond({'error':'list required'},400)
                if not body:return self.respond({'error':'Import rows must be non-empty'},400)
                clean=[validate_import_event(e,s['manifest']) for e in body]
                if q.get('region',['eu'])[0]=='us':return self.respond({'status':'accepted_transport_but_dropped_mock','num_records_imported':0})
                updated=deepcopy(s)
                for event in clean:updated['mixpanel'].append({'payload':event,'visible_at':s['clock']+1,'receipt':{'simulated':True,'http_status':200,'accepted':1}})
                commit(s,updated);return self.respond({'code':200,'status':'success_mock','num_records_imported':len(body)})
            if path.startswith('/api/') or path.startswith('/mock/'):return self.respond({'error':'not found'},404)
            return self.respond({'error':'not found'},404)
        except paid_access.APIError as exc:return self.respond({'error':str(exc),'state':'needs_recheck' if exc.status==409 else 'rejected'},exc.status)
        except CollectorAuthError as exc:return self.respond({'error':str(exc)},401)
        except (KeyError,ValueError,TypeError,UnicodeDecodeError,json.JSONDecodeError) as exc:return self.respond({'error':str(exc) or 'bad request'},400)
        except Exception:return self.respond({'error':'internal error'},500)

def verify():
    s=seed();r=detect(s);o=json.loads(EVAL.read_text());assert r['gap']==o['expected_before_gap'],r['gap']
    assert {x['cls'] for x in r['groups']}==set(o['expected_initial_groups'])
    assert sum(len(x['findings']) for x in r['groups'])==7
    raw_before=r['raw_event_count'];assert r['query_event_count']==raw_before
    approved=['MISSING_IN_MIXPANEL','PRICE_MISMATCH','DUPLICATE_IN_MIXPANEL']
    approve(s,approved);s=read();map_name(s,'premium_paid_v2','purchase','demo-operator');s=read()
    assert do_apply(s,approved)['writes_accepted']==4
    s=read();assert detect(s)['gap']==r['gap'] # delayed visibility
    after=advance(s,1);assert after['gap']==o['expected_after_gap'],after['gap']
    assert {x['cls'] for x in after['groups']}=={'EXTRA_IN_MIXPANEL','SANDBOX_EXPECTED'}
    s=read();assert do_apply(s,approved)['writes_accepted']==0
    assert detect(read())['gap']==o['expected_after_gap']
    # No HTTP or external calls ever issued by this script; both approval paths are local.
    print('PASS: 6 classes, 7 findings, 3 approved groups, 4 mocked writes, mapping, delayed verify, ghost, retry no-op, per-currency exact values')

def main():
    ap=argparse.ArgumentParser(description='100% local mock stateful Reconcile demo; zero provider calls')
    ap.add_argument('command',choices=['seed','report','approve','apply','map','advance','verify','check','serve','reset'])
    ap.add_argument('args',nargs='*');ap.add_argument('--port',type=int,default=8765)
    a=ap.parse_args()
    if a.command in ('seed','reset'):print(canon(seed()['manifest']));return
    if a.command=='check':verify();return
    if not STATE.exists():raise SystemExit('Run: python3 reconcile_mock.py seed')
    s=read()
    if a.command=='report':print(json.dumps(detect(s),ensure_ascii=False,indent=2));return
    if a.command=='approve':res=approve(s,a.args or ['MISSING_IN_MIXPANEL','PRICE_MISMATCH','DUPLICATE_IN_MIXPANEL']);print(canon(res));return
    if a.command=='apply':res=do_apply(s,a.args or ['MISSING_IN_MIXPANEL','PRICE_MISMATCH','DUPLICATE_IN_MIXPANEL']);print(canon({k:v for k,v in res.items() if k!='report'}));return
    if a.command=='map':print(canon(map_name(s,*(a.args or ['premium_paid_v2','purchase']),actor='demo-operator')));return
    if a.command=='advance':print(canon(advance(s,int(a.args[0]) if a.args else 1)['gap']));return
    if a.command=='verify':print(canon(detect(s)['gap']));return
    if a.command=='serve':
        paid_access.ensure()
        print(f'MOCK ONLY at http://127.0.0.1:{a.port}, no external services');LocalServer(('127.0.0.1',a.port),Handler).serve_forever()

class LocalServer(ThreadingHTTPServer):
    # The UI fires ~7 parallel reads after each action. The stdlib default backlog of 5
    # lets macOS reset the next connection, which the browser reports as "Failed to fetch".
    request_queue_size=64
    daemon_threads=True
if __name__=='__main__':main()
