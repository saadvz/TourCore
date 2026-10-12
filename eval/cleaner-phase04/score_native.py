"""Score native screening against frozen labels, separate from full pipelines."""
import argparse
import hashlib
import json
import math
from pathlib import Path
ROOT=Path(__file__).resolve().parent
ACCESS={'ARRIVAL','AT_UNIT','AT_ROUTE_STOP'}
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def quantile(values,q):
 return sorted(values)[max(0,math.ceil(q*len(values))-1)] if values else None
def number(value):return isinstance(value,(float,int)) and not isinstance(value,bool) and math.isfinite(value) and value>=0
def score(path,kind):
 p=json.loads(path.read_text());dpath=ROOT/('sms-cases.json' if kind=='intent' else 'draft-cases.json')
 cases=json.loads(dpath.read_text())['cases']
 assert p['datasetSha256']==digest(dpath),'Wrong dataset hash'
 assert p['evaluationStage']=='native_'+kind+'_screening','Wrong stage'
 assert p['questionSpecSha256']==digest(ROOT/'native-questions.json'),'Question specification changed'
 assert len(p['rows'])==len(cases),'Partial run cannot be scored as complete'
 by_id={r['id']:r for r in p['rows']};assert len(by_id)==len(cases),'Duplicate IDs'
 keys=json.loads((ROOT/'native-questions.json').read_text())[kind]['criteria']
 rows=[]
 for c in cases:
  assert c['id'] in by_id,'Missing case'
  r=by_id[c['id']];probs=r.get('probabilities')
  valid=not r.get('error') and r.get('choice') in keys and isinstance(probs,dict) and set(probs)==set(keys)
  valid=valid and all(number(v) and v<=1 for v in probs.values()) and abs(sum(probs.values())-1)<1e-4
  if valid:assert abs(r['selectedProbability']-probs[r['choice']])<1e-8
  if kind=='intent':
   expected=[x['type'] for x in c['expected']['acceptableIntents']]
   negative=not bool(set(expected)&ACCESS)
  else:expected=[c['expected']['decision']];negative=False
  rows.append({'id':c['id'],'category':c.get('category',c.get('scenario')),'valid':bool(valid),
               'correct':bool(valid and r['choice'] in expected),'choice':r.get('choice'),'acceptableLabels':expected,
               'accessNegative':negative,'rawAccessFalsePositive':bool(valid and negative and r['choice'] in ACCESS),
               'selectedProbability':r.get('selectedProbability'),'nativeConfidence':r.get('nativeConfidence'),
               'latencyMs':r.get('latencyMs'),'costUsd':r.get('costUsd'),'error':r.get('error')})
 def summary(rs):
  valid=sum(r['valid'] for r in rs);correct=sum(r['correct'] for r in rs);negative=sum(r['accessNegative'] for r in rs)
  lat=[r['latencyMs'] for r in rs if number(r['latencyMs'])]
  costs=[r['costUsd'] for r in rs if number(r['costUsd'])]
  assessed=[r for r in rs if r['valid'] and number(r['selectedProbability'])]
  return {'count':len(rs),'validCount':valid,'correctCount':correct,'labelAccuracy':correct/len(rs) if valid else None,
          'rawAccessFalsePositives':sum(r['rawAccessFalsePositive'] for r in rs) if kind=='intent' else None,
          'accessNegativeCount':negative if kind=='intent' else None,
          'unknownLabelRate':sum(r['valid'] and r['choice']=='UNKNOWN' for r in rs)/len(rs) if kind=='intent' else None,
          'selectedProbabilityBrierScore':sum((r['selectedProbability']-int(r['correct']))**2 for r in assessed)/len(assessed) if assessed else None,
          'p50LatencyMs':quantile(lat,.5),'p95LatencyMs':quantile(lat,.95),'latencyMeasuredCount':len(lat),
          'totalInferenceApiSpendUsd':sum(costs) if len(costs)==len(rs) else None,
          'meanInferenceApiSpendUsd':sum(costs)/len(rs) if len(costs)==len(rs) else None,
          'inferenceCostMeasuredCount':len(costs)}
 report={'schemaVersion':1,'candidateId':p['candidateId'],'stage':p['evaluationStage'],
         'datasetSha256':p['datasetSha256'],'questionSpecSha256':p['questionSpecSha256'],
         'inferenceIdentity':p['inferenceIdentity'],'timingScope':p['timingScope'],'costScope':p['costScope'],
         'confidenceSemantics':p['confidenceSemantics'],'summary':summary(rows),
         'byCategory':{cat:summary([r for r in rows if r['category']==cat]) for cat in dict.fromkeys(r['category'] for r in rows)},
         'failures':[r for r in rows if not r['correct']],
         'limitations':['Preliminary synthetic diagnostic labels, not an independent production holdout',
                        'Native label screening excludes entity extraction, generation, engine actions and real SMS',
                        'Neither native confidence nor selected probability is treated as calibrated engine authorization',
                        ('Local CPU API spend is zero, but self-hosting infrastructure cost is unmeasured' if p['transport']=='local'
                         else 'Hosted cost covers provider-reported native decision charges, excluding generation, entity extraction, retries outside this run and infrastructure')]}
 return report
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--input',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--kind',choices=['intent','constraint'],required=True)
 a=parser.parse_args();r=score(a.input,a.kind);a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r['summary'],indent=2))
if __name__=='__main__':main()
