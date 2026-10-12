import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCleanerPhase05 } from '../../src/delegation/phase05/service.ts';
import { Capability, AgentProfile } from '../../src/agents/profile.ts';
import type { ProviderBinding } from '../../src/delegation/phase05/engine.ts';
const destination=process.argv[2]??'eval/cleaner-phase05/results/fleet-resource-sample.json';
mkdirSync('work',{recursive:true});const root=mkdtempSync(join(process.cwd(),'work','fleet-meter-'));
const sourceSha256=Object.fromEntries(['store','engine','grants','service','notifications','profiles'].map(name=>[name,createHash('sha256').update(readFileSync(`src/delegation/phase05/${name}.ts`)).digest('hex')]));
const samples:any[]=[];const base=Date.parse('2026-10-12T12:00:00Z'),iso=(hours:number)=>new Date(base+hours*3600000).toISOString();
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const quantile=(values:number[],q:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1];
const io=()=>Object.fromEntries(readFileSync('/proc/self/io','utf8').trim().split('\n').map(line=>{const[k,v]=line.split(':');return[k,Number(v!.trim())];}));
const delta=(a:Record<string,number>,b:Record<string,number>)=>Object.fromEntries(Object.keys(a).map(k=>[k,b[k]!-a[k]!]));
try {
 for(const landlords of [2,10,100]) {
  const fixture=join(root,String(landlords));let now=base;
  const owners=Array.from({length:landlords},(_,n)=>({tenantId:`tenant_${String(n).padStart(3,'0')}`,token:randomBytes(32).toString('hex')}));
  const accepted=new Map<string,string>(),attempts=new Map<string,number>(),inject=new Set<string>(),wakeupBytes=new Map<string,number>();
  const bindings:ProviderBinding[]=owners.map(o=>({id:`provider_${o.tenantId}`,tenantId:o.tenantId,account:`account_${o.tenantId}`,number:`synthetic_${o.tenantId}`,recipient:`cleaner_${o.tenantId}`,ingressSecret:randomBytes(32).toString('hex'),credentialEpoch:'1',guarantee:'idempotent',send:async r=>{
    const count=(attempts.get(r.key)??0)+1;attempts.set(r.key,count);if(!accepted.has(r.key))accepted.set(r.key,`receipt_${r.key}`);
    if(inject.has(r.key)&&count===1)throw new Error('Injected lost acknowledgment');return {receipt:accepted.get(r.key)!};
  }}));
  const runtime=createCleanerPhase05({root:fixture,owners,bindings,now:()=>now,workerIntervalMs:0,limits:{requestsPerSecond:100000,sendsPerSecond:100000,retryMs:1},wakeups:owners.map(o=>({tenantId:o.tenantId,agentId:'same_agent',notify:async event=>{wakeupBytes.set(event.workId,bytes(event));return 202;}}))});
  try {
    const identities=owners.map(o=>runtime.grants.resolve(`Bearer ${o.token}`,'owner'));
    const agents=owners.map((o,n)=>{
      runtime.grants.agent(identities[n]!,{agentId:'same_agent'});const grant=runtime.grants.grant(identities[n]!,{agentId:'same_agent'});
      const profile=AgentProfile.parse({schemaVersion:1,tenantId:o.tenantId,agentId:'same_agent',adapterId:'grok',createdAt:iso(0),updatedAt:iso(0),nativeExtensions:[],grants:[],capabilities:Capability.options.map(capability=>({capability,declared:'available',...(['mcp_tools','background_runs'].includes(capability)?{evidence:{status:'verified',method:'operator_review',evidenceId:'benchmark_fixture',scope:'benchmark_fixture_not_live',observedAt:iso(0),expiresAt:iso(24*7),latencyMs:1}}:{})}))});
      runtime.store.run("UPDATE grants SET expires=? WHERE tenant=? AND role='agent'",base+30*86400000,o.tenantId);
      // Trusted synthetic benchmark injection only. This is explicitly not live capability evidence.
      runtime.store.run('INSERT INTO profiles VALUES(?,?,?,?)',o.tenantId,'same_agent',1,JSON.stringify(profile));
      return runtime.grants.resolve(`Bearer ${grant.access_token}`,'agent');
    });
    runtime.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const startupFiles=Object.fromEntries(readdirSync(fixture).map(f=>[f,statSync(join(fixture,f)).size]));
    const rows:any[]=[];let previous=0;
    for(const monthlyRequestsPerTenant of [20,100,300]) {
      const phaseCpu=process.cpuUsage(),phaseWall=performance.now(),phaseIo=io(),startIndex=rows.length;
      for(let request=previous;request<monthlyRequestsPerTenant;request++)for(let n=0;n<landlords;n++) {
        const b=bindings[n]!,tenant=b.tenantId,started=performance.now(),cpu=process.cpuUsage();
        await runtime.engine.saveTurn(identities[n]!,{id:`turn_${request}`,version:1,recipient:b.recipient,timeZone:'America/New_York',windowStart:iso(24),windowEnd:iso(30),nextArrival:iso(31),minimumMinutes:90});
        const id=runtime.engine.receive(b,{eventId:`event_${request}`,turnId:`turn_${request}`,requestedStart:iso(25)});
        if(request%10===0)inject.add(`reply_${id}`);
        await runtime.notifications.tick();
        const claim=await runtime.engine.claim(agents[n]!,id);
        const decision=await runtime.engine.propose(agents[n]!,{id,leaseToken:claim.leaseToken,actionKey:`action_${request}`,expectedTurnVersion:claim.turn.version,start:claim.requestedStart});
        await runtime.engine.tick();if(inject.has(`reply_${id}`)){now++;await runtime.engine.tick();}
        const status=await runtime.engine.get(agents[n]!,id);assert.equal(status.status,'completed');assert.ok(wakeupBytes.has(id));
        const used=process.cpuUsage(cpu);rows.push({tenant,request,workId:id,cpuMs:(used.user+used.system)/1000,wallMs:performance.now()-started,rssBytes:process.memoryUsage().rss,providerAttempts:attempts.get(`reply_${id}`),measuredOutboundJsonBytes:bytes(claim)+bytes(decision)+bytes(status)+wakeupBytes.get(id)!+bytes({key:`reply_${id}`,recipient:b.recipient,text:'Engine-owned deterministic confirmation'})});
        now+=1000; // Avoid the real two-per-second wakeup budget while compressing a month into a test run.
        if(rows.length%250===0)console.log(JSON.stringify({progress:true,landlords,completed:rows.length,target:landlords*monthlyRequestsPerTenant}));
      }
      const used=process.cpuUsage(phaseCpu),phaseElapsed=performance.now()-phaseWall,phaseEndIo=io();
      const idleCpu=process.cpuUsage(),idleWall=performance.now(),idleIo=io();
      for(let cycle=0;cycle<50;cycle++){await runtime.engine.tick();await runtime.notifications.tick();}
      const idleUsed=process.cpuUsage(idleCpu),idleElapsed=performance.now()-idleWall,idleEndIo=io();
      const beforeCheckpoint=Object.fromEntries(readdirSync(fixture).map(f=>[f,statSync(join(fixture,f)).size]));runtime.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const files=Object.fromEntries(readdirSync(fixture).map(f=>[f,statSync(join(fixture,f)).size]));
      assert.equal(accepted.size,landlords*monthlyRequestsPerTenant);
      assert.equal(runtime.store.one<{n:number}>("SELECT COUNT(*) n FROM work WHERE status='completed'")!.n,accepted.size);
      const subset=rows.slice(startIndex),allCpu=rows.reduce((total,r)=>total+r.cpuMs,0);
      const sample={landlords,monthlyRequestsPerTenant,totalCompleted:rows.length,phaseRequests:subset.length,phaseCpuMs:(used.user+used.system)/1000,phaseWallMs:phaseElapsed,phaseIoDelta:delta(phaseIo,phaseEndIo),cumulativeLifecycleCpuMs:allCpu,cpuMsPerWorkflow:allCpu/rows.length,p95WallMs:quantile(rows.map(r=>r.wallMs),.95),maxRssBytesObserved:Math.max(...rows.map(r=>r.rssBytes)),startupFiles,liveFilesBeforeCheckpoint:beforeCheckpoint,checkpointedFiles:files,providerAttempts:rows.reduce((sum,r)=>sum+r.providerAttempts,0),notificationAcceptances:runtime.store.one<{n:number}>("SELECT COUNT(*) n FROM notifications WHERE status='accepted'")!.n,outboundJsonBytes:rows.reduce((sum,r)=>sum+r.measuredOutboundJsonBytes,0),idle:{cycles:50,cpuMs:(idleUsed.user+idleUsed.system)/1000,wallMs:idleElapsed,cpuMsPerCycle:(idleUsed.user+idleUsed.system)/1000/50,ioDelta:delta(idleIo,idleEndIo)},perTenant:owners.map(o=>{const own=rows.filter(r=>r.tenant===o.tenantId);return {tenantId:o.tenantId,requests:own.length,cpuMs:own.reduce((sum,r)=>sum+r.cpuMs,0),providerAttempts:own.reduce((sum,r)=>sum+r.providerAttempts,0),workRecords:runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM work WHERE tenant=?',o.tenantId)!.n};})};
      samples.push(sample);console.log(JSON.stringify({sampleCompleted:true,landlords,monthlyRequestsPerTenant,totalCompleted:rows.length,cpuMsPerWorkflow:sample.cpuMsPerWorkflow,idleCpuMsPerCycle:sample.idle.cpuMsPerCycle,p95WallMs:sample.p95WallMs}));
      writeFileSync(join(root,`rows-${landlords}.json`),JSON.stringify(rows));previous=monthlyRequestsPerTenant;
    }
    // Persist raw per-workflow observations separately; fixtures and credential material are removed.
    const raw=join(dirname(destination),`fleet-${landlords}-workflows.jsonl.gz`);mkdirSync(dirname(raw),{recursive:true});writeFileSync(raw,gzipSync(rows.map(row=>JSON.stringify(row)).join('\n')+'\n'));
  }finally{await runtime.close();}
  mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,JSON.stringify({schemaVersion:1,status:landlords===100?'completed':'running',generatedAt:new Date().toISOString(),scope:'Actual local indexed lifecycles and wakeup workers for 2/10/100 synthetic landlords, 20/100/300 workflows each; phases retain earlier history. Every tenth workflow loses first idempotent-provider acknowledgment.',measurement:{agent:'Injected immediate wakeup acceptance, scripted engine calls; no real Grok or inference. Readiness evidence is an explicit trusted benchmark fixture.',cpu:'Whole-process lifecycle deltas and idle sweeps; per-tenant sequential attribution includes shared scans, not private tenant CPU',network:'Outbound business JSON bytes; provider body proxy is estimated, HTTP/TLS/vendor traffic excluded',memory:'Sampled process RSS, not billed container memory',workerIntervalMsForProjection:250,rateLimits:'Bulk sampler lifts starts/sec to avoid clock-compression throttling; production/default budgets are tested in acceptance suite',realSms:0,doors:0,externalInferenceCalls:0},sourceSha256,samples},null,2)+'\n');
 }
}finally{rmSync(root,{recursive:true,force:true});}
