export interface CostInputs {
  landlords:number; requestsPerLandlord:number; days:number;
  workflowCpuMs:number; idleCpuMsPerCycle:number; workerIntervalMs:number;
  billedRamGb:number; primaryStorageGb:number; backupStorageGb:number; egressGb:number;
  cpuUsdPerMinute:number; ramUsdPerGbMinute:number; volumeUsdPerGbMinute:number; egressUsdPerGb:number;
  monthlyMinimumUsd:number; inferenceUsd:number; additionalApiUsd:number; capacityMultiplier:number;
}
/** A scenario calculator, not an invoice meter. Vendor billed memory/storage remain explicit inputs. */
export function cleanerCostModel(input:CostInputs) {
  const fields:Array<keyof CostInputs>=['landlords','requestsPerLandlord','days','workflowCpuMs','idleCpuMsPerCycle','workerIntervalMs','billedRamGb','primaryStorageGb','backupStorageGb','egressGb','cpuUsdPerMinute','ramUsdPerGbMinute','volumeUsdPerGbMinute','egressUsdPerGb','monthlyMinimumUsd','inferenceUsd','additionalApiUsd','capacityMultiplier'];
  for(const name of fields){const value=input[name];if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error(`Invalid nonnegative cost input: ${name}`);}
  for(const name of ['landlords','days','workerIntervalMs','capacityMultiplier'] as const)if(input[name]<=0)throw new Error(`Positive ${name} required`);
  if(!Number.isSafeInteger(input.landlords)||!Number.isSafeInteger(input.requestsPerLandlord))throw new Error('Whole landlord and request counts required');
  const seconds=input.days*86400,minutes=seconds/60,requests=input.landlords*input.requestsPerLandlord;
  const activeCpuSeconds=requests*input.workflowCpuMs/1000*input.capacityMultiplier;
  const idleCpuSeconds=seconds/input.workerIntervalMs*input.idleCpuMsPerCycle*input.capacityMultiplier;
  const components={cpuUsd:(activeCpuSeconds+idleCpuSeconds)/60*input.cpuUsdPerMinute,ramUsd:input.billedRamGb*minutes*input.ramUsdPerGbMinute,primaryStorageUsd:input.primaryStorageGb*minutes*input.volumeUsdPerGbMinute,backupStorageUsd:input.backupStorageGb*minutes*input.volumeUsdPerGbMinute,egressUsd:input.egressGb*input.egressUsdPerGb,inferenceUsd:input.inferenceUsd,additionalApiUsd:input.additionalApiUsd};
  // Inference/other API invoices do not consume hosting credits.
  const hostingUsageUsd=components.cpuUsd+components.ramUsd+components.primaryStorageUsd+components.backupStorageUsd+components.egressUsd;
  const hostingInvoiceUsd=Math.max(input.monthlyMinimumUsd,hostingUsageUsd);
  const totalUsd=hostingInvoiceUsd+input.inferenceUsd+input.additionalApiUsd,perLandlordUsd=totalUsd/input.landlords;
  return {requests,activeCpuSeconds,idleCpuSeconds,averageCpuCores:(activeCpuSeconds+idleCpuSeconds)/seconds,components,hostingUsageUsd,hostingInvoiceUsd,totalUsd,perLandlordUsd,withinFiveDollarTarget:perLandlordUsd<=5};
}
