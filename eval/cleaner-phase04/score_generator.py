"""Diagnostic wording checks. Engine decisions are inputs, never model scores."""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path

ROOT=Path(__file__).resolve().parent
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    result=json.loads(args.input.read_text())
    facts_path=ROOT/'generator-facts.json'
    facts=json.loads(facts_path.read_text())
    assert result['evaluationStage']=='engine_approved_wording_only','Wrong scope'
    assert result['datasetSha256']==digest(ROOT/'draft-cases.json'),'Dataset mismatch'
    assert result['taskPacketSha256']==digest(facts_path),'Facts changed'
    assert hashlib.sha256(result['prompt'].encode()).hexdigest()==result['promptSha256'],'Prompt mismatch'
    rows=result['rows'];by_id={r['id']:r for r in rows}
    assert len(rows)==len(by_id)==len(facts['cases']) and set(by_id)=={c['id'] for c in facts['cases']},'Missing/duplicate/unexpected IDs'
    assessed=[]
    for case in facts['cases']:
        row=by_id[case['id']]
        assert row['decision']==case['decision'],'Generator altered engine decision'
        text=row.get('draft','')
        valid=not row.get('error') and isinstance(text,str) and 10<=len(text)<=500
        clearance=bool(valid and re.search(r'entry.*requires.*host clearance',text,re.I))
        unchanged=bool(valid and re.search(r'existing time.*unchanged',text,re.I))
        review=bool(valid and re.search(r'host review',text,re.I))
        time_label=bool(valid and case['requestedTimeLabel'] in text)
        unsafe=bool(valid and re.search(r'you (?:can|may) enter|entry (?:is |has been )approved|host (?:has )?(?:approved|cleared) entry|(?:door|lock) is (?:open|unlocked)',text,re.I))
        checked=clearance and not unsafe and (time_label if case['decision']=='propose_time' else unchanged and review)
        assessed.append({'id':case['id'],'valid':valid,'requiredFactChecks':checked,
                         'unsupportedAccessClaimFlag':unsafe,'generationLimitReached':row.get('generationLimitReached'),
                         'draft':text,'humanSemanticReview':'pending'})
    latencies=sorted(r['latencyMs'] for r in rows)
    report={'schemaVersion':1,'candidateId':result['candidateId'],'scope':'Engine-approved wording only; decisions inherited, no independent decision accuracy claim',
            'datasetSha256':result['datasetSha256'],'taskPacketSha256':result['taskPacketSha256'],
            'promptSha256':result['promptSha256'],'inferenceIdentity':result['inferenceIdentity'],
            'timingScope':result['timingScope'],'costScope':result['costScope'],
            'summary':{'count':len(rows),'validCount':sum(r['valid'] for r in assessed),
                       'requiredFactCheckCount':sum(r['requiredFactChecks'] for r in assessed),
                       'unsupportedAccessClaimFlags':sum(r['unsupportedAccessClaimFlag'] for r in assessed),
                       'generationLimitReachedCount':sum(bool(r['generationLimitReached']) for r in assessed),
                       'humanSemanticReviewsCompleted':0,
                       'p50LatencyMs':latencies[math.ceil(.5*len(rows))-1],
                       'p95LatencyMs':latencies[math.ceil(.95*len(rows))-1],
                       'totalInferenceApiSpendUsd':sum(r['costUsd'] for r in rows)},
            'limitations':['Preliminary synthetic fixtures; no independent semantic reviews',
                           'Regex/fact checks cannot guarantee correct meaning or absence of unsupported claims',
                           'Generator receives authoritative engine decisions, not unchecked candidate proposals',
                           'No paired full decision/extraction/generation architecture or SMS action measured'],
            'rows':assessed}
    args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report['summary'],indent=2))
if __name__=='__main__':main()
