import { expect,it } from 'vitest';
import { cleanerCostModel, type CostInputs } from '../src/delegation/phase05/costModel';
const base:CostInputs={landlords:2,requestsPerLandlord:20,days:30,workflowCpuMs:10,idleCpuMsPerCycle:1,workerIntervalMs:250,billedRamGb:.5,primaryStorageGb:.1,backupStorageGb:.2,egressGb:.1,cpuUsdPerMinute:20/43200,ramUsdPerGbMinute:10/43200,volumeUsdPerGbMinute:.15/43200,egressUsdPerGb:.05,monthlyMinimumUsd:5,inferenceUsd:0,additionalApiUsd:0,capacityMultiplier:1};
it('charges the hosting minimum once, with included credits rather than a subscription plus the full usage again',()=>{
  const low=cleanerCostModel({...base,billedRamGb:0,idleCpuMsPerCycle:0,workflowCpuMs:0});expect(low.hostingInvoiceUsd).toBe(5);expect(low.perLandlordUsd).toBe(2.5);
  const high=cleanerCostModel({...base,billedRamGb:1});expect(high.hostingInvoiceUsd).toBe(high.hostingUsageUsd);expect(high.totalUsd).toBeLessThan(11);
});
it('converts milliseconds, CPU minutes, RAM/storage minutes and egress units correctly',()=>{
  const x=cleanerCostModel({...base,landlords:1,requestsPerLandlord:1,workflowCpuMs:1000,idleCpuMsPerCycle:0,billedRamGb:1,primaryStorageGb:1,backupStorageGb:0,egressGb:1,monthlyMinimumUsd:0});
  expect(x.activeCpuSeconds).toBe(1);expect(x.components.cpuUsd).toBeCloseTo(20/(30*86400));expect(x.components.ramUsd).toBe(10);expect(x.components.primaryStorageUsd).toBe(.15);expect(x.components.egressUsd).toBe(.05);
});
it('includes always-running worker CPU and adds independent API invoices after hosting credits',()=>{
  const x=cleanerCostModel({...base,workflowCpuMs:0,idleCpuMsPerCycle:250,inferenceUsd:7,additionalApiUsd:3});expect(x.averageCpuCores).toBe(1);expect(x.components.cpuUsd).toBeCloseTo(20);expect(x.totalUsd).toBeCloseTo(x.hostingInvoiceUsd+10);
});
it.each([2,10,100])('tests all low/medium/high usage tiers at %i landlords and retains exact fleet totals',landlords=>{
  const results=[20,100,300].map(requestsPerLandlord=>cleanerCostModel({...base,landlords,requestsPerLandlord}));expect(results.map(x=>x.requests)).toEqual([20,100,300].map(n=>n*landlords));expect(results[2]!.totalUsd).toBeGreaterThanOrEqual(results[0]!.totalUsd);
});
it('exposes plan-floor failures and inference stress instead of hiding them in per-message marginal cost',()=>{
  expect(cleanerCostModel({...base,monthlyMinimumUsd:20}).withinFiveDollarTarget).toBe(false);
  expect(cleanerCostModel({...base,landlords:100,requestsPerLandlord:300,inferenceUsd:100*300*.042,monthlyMinimumUsd:20}).withinFiveDollarTarget).toBe(false);
});
it('scales calendar time, idle cadence, replicated capacity and fixed memory assumptions',()=>{
  const a=cleanerCostModel({...base,monthlyMinimumUsd:0}),b=cleanerCostModel({...base,days:31,monthlyMinimumUsd:0}),c=cleanerCostModel({...base,workerIntervalMs:500,monthlyMinimumUsd:0}),d=cleanerCostModel({...base,capacityMultiplier:10,monthlyMinimumUsd:0});
  expect(b.components.ramUsd/a.components.ramUsd).toBeCloseTo(31/30);expect(c.idleCpuSeconds/a.idleCpuSeconds).toBe(.5);expect(d.components.cpuUsd/a.components.cpuUsd).toBeCloseTo(10);
});
it('rejects missing, negative, nonfinite and fractional accounting inputs',()=>{
  for(const override of [{landlords:0},{landlords:1.5},{requestsPerLandlord:-1},{workflowCpuMs:NaN},{workerIntervalMs:0},{billedRamGb:Infinity},{billedRamGb:undefined}])expect(()=>cleanerCostModel({...base,...override} as CostInputs)).toThrow();
});
