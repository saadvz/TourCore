"""Native decision screening only. Inputs are label-free exports; no tools or SMS.

Local runtime code/weights are pinned and checked against the full manifest.
Hosted runs use only OpenRouter's documented Decisions endpoint and API binding.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
HOSTED = {'microsoft/microsoft-decision-1', 'perplexity/pplx-decider-v1.1-27b'}
REVISIONS = {'d3-edge':'18d61df78684675463af9ae732872478845c5a79',
             'd3-lite':'a8d25a91ef75552803f7009d25b7bd435991abd9',
             'd3-nano':'3aeb1c22a5632aac72353c36b3d0111c40e7dbf4'}
MANIFEST_HASHES = {'d3-edge':'2eb3066c44c11555eef253c7f4f3c749e4e6f88863b2dcd1268b276c7b89611c',
                   'd3-lite':'810a04f3e6979adb2289aa8fc151155bf8fd2c2bc33a60248d33238632b22716',
                   'd3-nano':'1e5d4d276d908e1acfd1caf71dd0f39f9280bed3dc7ad3e8727edb0371956147'}
def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(16<<20),b''):h.update(block)
    return h.hexdigest()
def write(path,data):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(data,indent=2)+'\n');temporary.replace(path)
def number(value):return isinstance(value,(float,int)) and not isinstance(value,bool) and math.isfinite(value) and value>=0
def validate_answer(answer,criteria):
    if not isinstance(answer,dict) or answer.get('type')!='choice' or answer.get('choice') not in criteria:
        raise ValueError('invalid_choice')
    probabilities=answer.get('probabilities')
    if not isinstance(probabilities,dict) or set(probabilities)!=set(criteria):raise ValueError('missing_probabilities')
    if not all(number(v) and v<=1 for v in probabilities.values()):raise ValueError('invalid_probabilities')
    if abs(sum(probabilities.values())-1)>1e-4:raise ValueError('probabilities_not_normalized')
    confidence=answer.get('confidence')
    if confidence is not None and (not number(confidence) or confidence>1):raise ValueError('invalid_confidence')
    return {'choice':answer['choice'],'probabilities':probabilities,'nativeConfidence':confidence,
            'selectedProbability':probabilities[answer['choice']]}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
def prepare_local(model_name):
    model_dir=Path('/workspace/cleaner-phase04-models')/model_name
    if sha(model_dir/'MODEL_MANIFEST.json')!=MANIFEST_HASHES[model_name]:raise ValueError('checkpoint_revision_manifest_mismatch')
    manifest=json.loads((model_dir/'MODEL_MANIFEST.json').read_text())
    if manifest.get('schema')!='d3-package-manifest/1':raise ValueError('invalid_manifest')
    for name,digest in manifest['files_sha256'].items():
        path=model_dir/name
        if not path.is_file() or path.stat().st_size!=manifest['files_bytes'][name] or sha(path)!=digest:
            raise ValueError('package_integrity_failure')
    # Only the reviewed, pinned local module is executed; no dynamic code download.
    os.environ['HF_HUB_OFFLINE']='1';os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
    sys.path.insert(0,str(model_dir))
    import torch
    from d3_runtime import D3
    torch.set_num_threads(4);torch.set_num_interop_threads(1)
    started=time.perf_counter()
    model=D3.from_pretrained(model_dir,device='cpu',verify='full',model_name='vllm-sr/'+model_name)
    identity={'artifact':'vllm-sr/'+model_name,'revision':REVISIONS[model_name],
              'verification':'full_manifest_sha256','device':'cpu','torch':torch.__version__,
              'transformers':__import__('transformers').__version__,'threads':4,
              'backboneDtype':'bfloat16','readoutDtype':'float32','loadSeconds':time.perf_counter()-started}
    return model.system_one,identity
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--transport',choices=['local','openrouter'],required=True)
    parser.add_argument('--model',required=True)
    parser.add_argument('--tasks',type=Path,required=True)
    parser.add_argument('--kind',choices=['intent','constraint'],required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--resume',action='store_true')
    parser.add_argument('--limit',type=int)
    parser.add_argument('--max-api-spend-usd',type=float,default=1.0)
    parser.add_argument('--dry-run',action='store_true')
    args=parser.parse_args()
    if not number(args.max_api_spend_usd) or args.max_api_spend_usd==0:parser.error('Positive API budget required')
    tasks=json.loads(args.tasks.read_text());spec=json.loads((ROOT/'native-questions.json').read_text())
    cases=tasks['cases']
    if len({c['id'] for c in cases})!=len(cases):raise ValueError('duplicate_input_cases')
    for c in cases:
        if any(k in c for k in ['expected','rationale','scenario']):raise ValueError('annotation_in_candidate_input')
    if args.kind=='intent' and set(tasks['intentTypes'])!=set(spec['intent']['criteria']):raise ValueError('taxonomy_mismatch')
    if args.limit is not None:
        if args.limit<=0:parser.error('Positive limit required')
        cases=cases[:args.limit]
    model_id='vllm-sr/'+args.model if args.transport=='local' else args.model
    if args.transport=='local' and args.model not in REVISIONS:parser.error('Only inspected local checkpoints are supported')
    if args.transport=='openrouter' and args.model not in HOSTED:parser.error('Model must be one of the two verified hosted candidates')
    print(json.dumps({'model':model_id,'kind':args.kind,'cases':len(cases),'dryRun':args.dry_run}),flush=True)
    if args.dry_run:return
    result={'schemaVersion':1,'candidateId':model_id,'evaluationStage':'native_'+args.kind+'_screening',
        'datasetSha256':tasks['datasetSha256'],'taskPacketSha256':sha(args.tasks),
        'questionSpecSha256':sha(ROOT/'native-questions.json'),'promptRevision':spec['promptRevision'],
        'transport':args.transport,'timingScope':('Sequential local native call including input formatting, tokenization, CPU forward and decode; excludes checkpoint load, app actions and SMS' if args.transport=='local' else 'Sequential HTTPS POST including transport and provider inference; excludes client startup, metadata reads, app actions and SMS'),
        'costScope':'Marginal inference API spend only; self-hosted infrastructure is unmeasured',
        'generatedAt':datetime.now(timezone.utc).isoformat(),'rows':[],'segments':[]}
    if args.resume and args.output.exists():
        previous=json.loads(args.output.read_text())
        for key in ['candidateId','evaluationStage','datasetSha256','taskPacketSha256','questionSpecSha256','transport']:
            if previous.get(key)!=result[key]:raise ValueError('resume_identity_mismatch')
        result=previous
    existing={r['id'] for r in result['rows']}
    if len(existing)!=len(result['rows']) or not existing.issubset({c['id'] for c in cases}):raise ValueError('invalid_resume_rows')
    api_spend=sum(r.get('costUsd') or 0 for r in result['rows'])
    if any(r.get('costUsd') is None for r in result['rows']) and args.transport=='openrouter':raise ValueError('cannot_resume_unknown_spend')
    stopped=None
    if args.transport=='local':
        call,identity=prepare_local(args.model)
        price=0.0
        result['confidenceSemantics']='Native confidence is normalized entropy, not selected-label probability; both are retained and neither is treated as calibrated correctness'
    else:
        key=os.environ.get('OPENROUTER_API_KEY')
        if not key:raise ValueError('OPENROUTER_API_KEY_missing')
        with urllib.request.urlopen('https://openrouter.ai/api/v1/models?output_modalities=decisions',timeout=30) as response:catalog=json.load(response)['data']
        entry=next((x for x in catalog if x['id']==args.model),None)
        if not entry:raise ValueError('hosted_model_no_longer_listed')
        price=float(entry['pricing']['prompt'])
        if not number(price):raise ValueError('invalid_published_price')
        if float(entry['pricing'].get('completion',0))!=0:raise ValueError('unexpected_completion_pricing')
        identity={'artifact':args.model,'canonicalSlug':entry['canonical_slug'],'publishedPromptPricePerToken':price}
        opener=urllib.request.build_opener(NoRedirect)
        key_request=urllib.request.Request('https://openrouter.ai/api/v1/key',headers={'Authorization':'Bearer '+key})
        with opener.open(key_request,timeout=30) as response:key_info=json.load(response).get('data',{})
        key_limit=key_info.get('limit')
        if not number(key_limit) or key_limit<=0:raise ValueError('A positive, known OpenRouter key credit limit is required')
        if not 0<args.max_api_spend_usd<=1:raise ValueError('Hosted runs must have a local budget of at most $1')
        identity['apiKeyCreditLimitUsd']=key_limit
        def call(state,questions):
            payload=json.dumps({'model':args.model,'state':state,'questions':questions}).encode()
            # UTF-8 byte count plus overhead is a conservative request-token allowance.
            if api_spend+(len(payload)+512)*price>args.max_api_spend_usd:raise ValueError('api_budget_exhausted')
            request=urllib.request.Request(ENDPOINT,data=payload,method='POST',headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
            with opener.open(request,timeout=30) as response:return json.load(response)
        result['confidenceSemantics']='Provider-native confidence and selected probability retained; calibration must be evaluated separately'
    result['inferenceIdentity']=identity
    result['segments'].append({'startedAt':datetime.now(timezone.utc).isoformat(),'resumeAfterRows':len(existing),'identity':identity})
    for c in cases:
        if c['id'] in existing:continue
        question=spec[args.kind]
        state=c['context'] if args.kind=='intent' else {k:v for k,v in c.items() if k!='id'}
        started=time.perf_counter();row={'id':c['id'],'costUsd':None,'latencyMs':None}
        if stopped:
            row['error']='not_attempted_after_'+stopped
        else:
            try:
                raw=call(state=state,questions={args.kind:question})
                row['latencyMs']=(time.perf_counter()-started)*1000
                row['returnedModel']=raw.get('model')
                usage=raw.get('usage') or {}
                row['inputTokens']=usage.get('input_tokens');row['outputTokens']=usage.get('output_tokens')
                cost=0.0 if args.transport=='local' else usage.get('cost')
                if not number(cost):
                    row['costUsd']=None;stopped='unknown_spend';raise ValueError('provider_cost_unavailable')
                row['costUsd']=cost;api_spend+=cost
                if api_spend>=args.max_api_spend_usd:stopped='api_budget_exhausted'
                row.update(validate_answer(raw.get('answers',{}).get(args.kind),question['criteria']))
            except urllib.error.HTTPError as error:
                row['error']='http_'+str(error.code)
                if error.code in [401,402,403,404]:stopped=row['error']
                else:stopped='uncertain_spend'
            except Exception as error:
                # No raw exception/body/header is retained: those may contain credentials.
                row['error']=str(error) if isinstance(error,ValueError) and str(error) in ['invalid_choice','missing_probabilities','invalid_probabilities','probabilities_not_normalized','invalid_confidence','provider_cost_unavailable','api_budget_exhausted'] else type(error).__name__
                if args.transport=='openrouter' and row['costUsd'] is None:stopped=stopped or 'uncertain_spend'
            if row['latencyMs'] is None:row['latencyMs']=(time.perf_counter()-started)*1000
        result['rows'].append(row);write(args.output,result)
        print(json.dumps({'completedRows':len(result['rows']),'totalRows':len(cases),'id':c['id'],'error':row.get('error')}),flush=True)
    print('Saved native screening; it does not measure extracted entities or generated replies.',flush=True)
if __name__=='__main__':main()
