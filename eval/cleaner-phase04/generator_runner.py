"""Offline wording screen using engine-approved facts, never model authorization."""
import argparse
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODEL = 'Qwen/Qwen3.5-0.8B'
REVISION = '2fc06364715b967f1860aea9cf38778875588b17'
DIRECTORY = Path('/workspace/cleaner-phase04-models/qwen-generator')
PROMPT = ('Write only a concise SMS draft in English, at most two sentences, using the supplied '
          'engine-approved facts. Do not decide or change the cleaning time. For propose_time, '
          'say cleaning is scheduled and copy requestedTimeLabel exactly. For host_review, say '
          'the change awaits host review and the existing time is unchanged. In both cases '
          'explicitly say entry requires host clearance. Do not claim entry is approved, a door '
          'is unlocked, an external booking was changed, or that you sent anything.')

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def prepare():
    from huggingface_hub import HfApi, snapshot_download
    info = HfApi(token=False).model_info(MODEL, revision=REVISION, files_metadata=True)
    if info.sha != REVISION or info.card_data.get('license') != 'apache-2.0':
        raise ValueError('Unexpected model identity/license')
    files = [f for f in info.siblings if f.rfilename.endswith(('.json','.safetensors','.txt','.jinja'))
             or f.rfilename in ['LICENSE','README.md']]
    snapshot_download(MODEL, revision=REVISION, local_dir=DIRECTORY,
                      allow_patterns=[f.rfilename for f in files], token=False, max_workers=4)
    records = []
    for f in files:
        path = DIRECTORY/f.rfilename
        if not path.resolve().is_relative_to(DIRECTORY.resolve()):
            raise ValueError('Unsafe artifact path')
        if f.lfs:
            expected = f.lfs.sha256
            checksum = hashlib.sha256()
        else:
            expected = f.blob_id
            checksum = hashlib.sha1()
            checksum.update(f'blob {path.stat().st_size}\0'.encode())
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(1024*1024), b''):
                checksum.update(block)
        if checksum.hexdigest() != expected:
            raise ValueError('Artifact integrity mismatch')
        records.append({'path':f.rfilename,'bytes':path.stat().st_size,
                        'algorithm':'sha256' if f.lfs else 'git_blob_sha1','digest':expected})
    return {'artifact':MODEL,'revision':REVISION,'license':'apache-2.0','files':records}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tasks',type=Path)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--prepare-only',action='store_true')
    parser.add_argument('--resume',action='store_true')
    args = parser.parse_args()
    identity = prepare()
    if args.prepare_only:
        print(json.dumps(identity,indent=2));return
    if not args.tasks or not args.output:parser.error('--tasks and --output required')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    tasks = json.loads(args.tasks.read_text())
    if tasks.get('scope') != 'engine_approved_wording_only':raise ValueError('Wrong task scope')
    cases = tasks['cases']
    fields = {'id','decision','requestedTimeLabel','timeZone','entryRequiresHostClearance'}
    if len({c['id'] for c in cases}) != len(cases):raise ValueError('Duplicate IDs')
    if any(set(c) != fields or c['decision'] not in ['propose_time','host_review']
           or c['entryRequiresHostClearance'] is not True for c in cases):
        raise ValueError('Invalid authoritative fact input')
    result = {'schemaVersion':1,'candidateId':MODEL,'evaluationStage':'engine_approved_wording_only',
              'datasetSha256':tasks['datasetSha256'],'taskPacketSha256':digest(args.tasks),
              'inferenceIdentity':identity,'prompt':PROMPT,'promptSha256':hashlib.sha256(PROMPT.encode()).hexdigest(),
              'generationConfig':{'do_sample':False,'max_new_tokens':128,'enable_thinking':False},
              'generatedAt':datetime.now(timezone.utc).isoformat(),'transport':'local_cpu_stock_transformers',
              'timingScope':'Local tokenization and CPU generation only; excludes engine decision, checkpoint load, actions and SMS',
              'costScope':'Marginal inference API spend zero; CPU infrastructure unmeasured',
              'decisionSource':'Copied from actual delegation engine baseline, not decided by generator', 'rows':[]}
    if args.resume and args.output.exists():
        previous = json.loads(args.output.read_text())
        for key in ['candidateId','datasetSha256','taskPacketSha256','promptSha256','generationConfig']:
            if previous.get(key) != result[key]:raise ValueError('Resume identity mismatch')
        if previous['inferenceIdentity']['revision']!=REVISION:raise ValueError('Resume revision mismatch')
        result = previous
    done = {r['id'] for r in result['rows']}
    if len(done) != len(result['rows']) or not done.issubset({c['id'] for c in cases}):
        raise ValueError('Invalid resume rows')
    os.environ['HF_HUB_OFFLINE'] = '1'
    import torch
    from transformers import AutoTokenizer, AutoModelForImageTextToText
    torch.set_num_threads(4);torch.set_num_interop_threads(1)
    tokenizer = AutoTokenizer.from_pretrained(DIRECTORY,local_files_only=True,trust_remote_code=False)
    model = AutoModelForImageTextToText.from_pretrained(DIRECTORY,local_files_only=True,
               trust_remote_code=False,dtype=torch.bfloat16).eval()
    result['inferenceIdentity'].update({'torch':torch.__version__,'threads':4,'dtype':'bfloat16'})
    for case in cases:
        if case['id'] in done:continue
        started = time.perf_counter()
        row = {'id':case['id'],'decision':case['decision'],'costUsd':0}
        facts = {k:v for k,v in case.items() if k!='id'}
        try:
            text = tokenizer.apply_chat_template([
                {'role':'system','content':PROMPT},{'role':'user','content':json.dumps(facts)}],
                tokenize=False,add_generation_prompt=True,enable_thinking=False)
            encoded = tokenizer(text,return_tensors='pt')
            with torch.inference_mode():
                output = model.generate(**encoded,do_sample=False,max_new_tokens=128)
            tokens = output[0,encoded['input_ids'].shape[1]:]
            row.update({'draft':tokenizer.decode(tokens,skip_special_tokens=True).strip(),
                        'inputTokens':encoded['input_ids'].shape[1],'generatedTokens':len(tokens),
                        'generationLimitReached':len(tokens)==128})
        except Exception as error:
            row['error'] = type(error).__name__
        row['latencyMs'] = (time.perf_counter()-started)*1000
        result['rows'].append(row)
        temp = args.output.with_suffix(args.output.suffix+'.tmp')
        temp.write_text(json.dumps(result,indent=2)+'\n');temp.replace(args.output)
        print(json.dumps({'completed':len(result['rows']),'error':row.get('error')}),flush=True)

if __name__ == '__main__':main()
