import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cleanerCostModel } from '../../src/delegation/phase05/costModel.ts';
const measured=JSON.parse(readFileSync('eval/cleaner-phase05/results/fleet-resource-sample.json','utf8'));
assert.equal(measured.status,'completed');assert.equal(measured.samples.length,9);
const GB=1024**3;
const scenarios:any[]=[];
for(const sample of measured.samples) {
 const workflows=sample.landlords*sample.monthlyRequestsPerTenant;
 assert.equal(sample.totalCompleted,workflows);assert.equal(sample.notificationAcceptances,workflows);
 assert.equal(sample.providerAttempts,workflows+workflows/10);
 const databaseStart=sample.startupFiles['cleaner.sqlite'],databaseEnd=sample.checkpointedFiles['cleaner.sqlite'];
 const perWorkflowBytes=Math.max(0,databaseEnd-databaseStart)/workflows;
 for(const plan of [{name:'Hobby price reference',minimum:5},{name:'Pro price reference',minimum:20}])for(const billedRamGb of [.5,1,2])for(const capacityMultiplier of [1,10,50]) {
  // History is not automatically deleted by the runtime. 12/60 months are explicit horizon scenarios.
  for(const historyMonths of [12,60]) {
   const primaryStorageGb=(databaseStart+perWorkflowBytes*workflows*historyMonths+4*1024**2)/GB+.03; // WAL reserve + illustrative 1GB-volume filesystem overhead.
   const backupStorageGb=2*primaryStorageGb; // Two full-copy volume-price allowances; not a measured managed-backup bill.
   const egressGb=(sample.outboundJsonBytes+32768*workflows+2048*(sample.providerAttempts-workflows))/GB;
   const inputs={landlords:sample.landlords,requestsPerLandlord:sample.monthlyRequestsPerTenant,days:30,workflowCpuMs:sample.cpuMsPerWorkflow,idleCpuMsPerCycle:sample.idle.cpuMsPerCycle,workerIntervalMs:250,billedRamGb,primaryStorageGb,backupStorageGb,egressGb,cpuUsdPerMinute:.000463,ramUsdPerGbMinute:.000231,volumeUsdPerGbMinute:.000003472222222,egressUsdPerGb:.05,monthlyMinimumUsd:plan.minimum,inferenceUsd:0,additionalApiUsd:0,capacityMultiplier};
   const cost=cleanerCostModel(inputs),provisionedVolumeCeilingGb=plan.minimum===5?5:1000;
   scenarios.push({plan:plan.name,billedRamGb,capacityMultiplier,historyMonths,measurement:{totalCompleted:workflows,p95LocalWallMs:sample.p95WallMs,maxRssGb:sample.maxRssBytesObserved/GB,bytesPerWorkflow:perWorkflowBytes,cpuMsPerWorkflow:sample.cpuMsPerWorkflow,idleCpuMsPerCycle:sample.idle.cpuMsPerCycle},inputs,...cost,capacityAssumptions:{oneCpuAverageCapacityExceeded:cost.averageCpuCores>1,billedRamAssumptionBelowObservedRss:billedRamGb<sample.maxRssBytesObserved/GB,primaryVolumePlanCeilingExceeded:primaryStorageGb>provisionedVolumeCeilingGb},classification:'conditional projection; no hosting invoice or memory allocation guarantee'});
  }
 }
}
const baseline=scenarios.filter(s=>s.billedRamGb===1&&s.capacityMultiplier===1&&s.historyMonths===12);
// An optional paid-model sensitivity is calculation only: the production backend makes zero inference calls.
const optionalApiSensitivity=baseline.map(s=>({...s,inferenceSensitivity:{source:'Public x-ai/grok-4.7 catalog snapshot; no model calls',assumedUncachedInputTokensPerCall:4000,assumedOutputTokensPerCall:1000,callsPerWorkflow:3,costPerWorkflowUsd:3*(4000*.000002+1000*.000006)},withOptionalPaidApi:cleanerCostModel({...s.inputs,inferenceUsd:s.requests*3*(4000*.000002+1000*.000006)})}));
const report={schemaVersion:1,generatedAt:new Date().toISOString(),status:'model_calculations_tested',sourceHashes:{fleet: createHash('sha256').update(readFileSync('eval/cleaner-phase05/results/fleet-resource-sample.json')).digest('hex'),costModel:createHash('sha256').update(readFileSync('src/delegation/phase05/costModel.ts')).digest('hex')},measurementSource:measured.sourceSha256,priceSources:['https://docs.railway.com/reference/pricing/plans','https://railway.com/pricing','https://docs.railway.com/reference/volumes','https://openrouter.ai/api/v1/models'],assumptions:{monthlyRequestsPerLandlord:[20,100,300],landlords:[2,10,100],days:30,billingUnits:'Published per-minute container CPU/RAM/volume prices; GB conversion 2^30 bytes',alwaysRunningWorkerIntervalMs:250,billedRamGbCases:[.5,1,2],historyMonths:[12,60],headroomMultipliers:[1,10,50],backup:'Two hypothetical full copies priced at volume rate; no configured backup system or actual backup invoice',network:'Measured/estimated business JSON plus 32KiB protocol allowance per workflow and 2KiB per extra provider attempt; not vendor-measured TLS egress',plan:'Full dedicated account minimum allocated to this runtime, hosting credits applied once. This selects no host/plan.',inference:'Zero required backend inference. Landlord agent subscription, SMS numbers/carrier fees and door hardware excluded. Paid-model sensitivity is hypothetical.',retention:'No automatic archive deletion exists; history-month values are forecast horizons, not enacted retention policies'},limitations:['Local scripted lifecycles and injected providers are not live Grok or vendor performance','Billed container memory, filesystem cache, real egress and invoices require hosting measurements','Source hashes identify the runtime version loaded by the long-running fleet sampler, before later hosted-test integration edits','Additive idle+active CPU is conservative; CPU stress multipliers that exceed one average CPU need another capacity design','Request payload mix, bursts, support, human review labor, reservation providers and external account-system costs are not measured','Model accuracy depends on explicit prices and demand assumptions; arithmetic tests do not establish a production operating guarantee'],baseline,optionalApiSensitivity,scenarios};
writeFileSync('eval/cleaner-phase05/results/cost-scenarios.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(baseline.map(s=>({landlords:s.inputs.landlords,requestsPerLandlord:s.inputs.requestsPerLandlord,plan:s.plan,monthlyRuntimeUsd:s.totalUsd,perLandlordUsd:s.perLandlordUsd,withinFiveDollarTarget:s.withinFiveDollarTarget,capacityWarnings:s.capacityAssumptions})),null,2));
