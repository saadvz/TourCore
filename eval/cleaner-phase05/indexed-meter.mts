import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { createCleanerPhase05 } from '../../src/delegation/phase05/service.ts';
import type { ProviderBinding } from '../../src/delegation/phase05/engine.ts';

const output=process.argv[2]??'eval/cleaner-phase05/results/indexed-resource-sample.json';
mkdirSync('work',{recursive:true});const root=mkdtempSync(join(process.cwd(),'work','indexed-meter-'));
const procIo=()=>{try{return Object.fromEntries(readFileSync('/proc/self/io','utf8').trim().split('\n').map(line=>{const [k,v]=line.split(':');return [k,Number(v!.trim())];}));}catch{return null;}};
const p95=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
const samples:any[]=[];
try {
  for(const count of [20,100,300]) {
    const fixture=join(root,String(count));mkdirSync(fixture);const clock={t:Date.parse('2026-10-12T12:00:00Z')};
    const owners=['A','B'].map(tenantId=>({tenantId,token:randomBytes(32).toString('hex')}));
    const accepted=new Map<string,string>(),attempts=new Map<string,number>(),lost=new Set<string>();
    const bindings:ProviderBinding[]=owners.map(o=>({id:`provider_${o.tenantId}`,tenantId:o.tenantId,account:`account_${o.tenantId}`,number:`synthetic_${o.tenantId}`,recipient:`cleaner_${o.tenantId}`,ingressSecret:randomBytes(32).toString('hex'),credentialEpoch:'1',guarantee:'idempotent',send:async reply=>{
      const n=(attempts.get(reply.key)??0)+1;attempts.set(reply.key,n);
      if(!accepted.has(reply.key))accepted.set(reply.key,`synthetic_${reply.key}`);
      if(lost.has(reply.key)&&n===1)throw new Error('Injected lost acknowledgment');
      return {receipt:accepted.get(reply.key)!};
    }}));
    const runtime=createCleanerPhase05({root:fixture,owners,bindings,workerIntervalMs:0,now:()=>clock.t,limits:{sendsPerSecond:100000,requestsPerSecond:100000,retryMs:1}});
    try {
      const ownerIdentities=owners.map(o=>runtime.grants.resolve(`Bearer ${o.token}`,'owner'));
      const agents=owners.map((o,i)=>{runtime.grants.agent(ownerIdentities[i]!,{agentId:'same_agent'});const grant=runtime.grants.grant(ownerIdentities[i]!,{agentId:'same_agent'});return runtime.grants.resolve(`Bearer ${grant.access_token}`,'agent');});
      const rows:any[]=[];
      const iso=(hours:number)=>new Date(Date.parse('2026-10-12T12:00:00Z')+hours*3600000).toISOString();
      for(let n=0;n<count;n++) {
        const i=n%2,index=Math.floor(n/2),b=bindings[i]!,owner=ownerIdentities[i]!,agent=agents[i]!;
        const cpu=process.cpuUsage(),started=performance.now(),io=procIo();
        await runtime.engine.saveTurn(owner,{id:`turn_${index}`,version:1,recipient:b.recipient,timeZone:'America/New_York',windowStart:iso(24),windowEnd:iso(30),nextArrival:iso(31),minimumMinutes:90});
        const id=runtime.engine.receive(b,{eventId:`source_${index}`,turnId:`turn_${index}`,requestedStart:iso(25)});
        if(i===0&&index%10===0)lost.add(`reply_${id}`);
        const claim=await runtime.engine.claim(agent,id);
        await runtime.engine.propose(agent,{id,leaseToken:claim.leaseToken,actionKey:`action_${index}`,expectedTurnVersion:claim.turn.version,start:claim.requestedStart});
        await runtime.engine.tick();if(lost.has(`reply_${id}`)){clock.t++;await runtime.engine.tick();}
        assert.equal((await runtime.engine.get(agent,id)).status,'completed');
        const used=process.cpuUsage(cpu),endIo=procIo();
        rows.push({tenantId:b.tenantId,wallMs:performance.now()-started,cpuMs:(used.user+used.system)/1000,providerAttempts:attempts.get(`reply_${id}`),rssBytesObserved:process.memoryUsage().rss,processIoDelta:io&&endIo?Object.fromEntries(Object.keys(io).map(k=>[k,endIo[k]!-io[k]!])):null});
      }
      assert.equal(accepted.size,count);
      const beforeIo=procIo(),cpu=process.cpuUsage(),started=performance.now();
      for(let i=0;i<50;i++){await runtime.engine.tick();await runtime.notifications.tick();}
      const idleCpu=process.cpuUsage(cpu),idleIo=procIo(),idleWallMs=performance.now()-started;
      const liveFiles=Object.fromEntries(readdirSync(fixture).map(file=>[file,statSync(join(fixture,file)).size]));
      runtime.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const checkpointedFiles=Object.fromEntries(readdirSync(fixture).map(file=>[file,statSync(join(fixture,file)).size]));
      const perTenant=Object.fromEntries(owners.map(o=>[o.tenantId,{requests:rows.filter(r=>r.tenantId===o.tenantId).length,cpuMs:rows.filter(r=>r.tenantId===o.tenantId).reduce((n,r)=>n+r.cpuMs,0),workRecords:runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM work WHERE tenant=?',o.tenantId)!.n,auditRecords:runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM audit WHERE tenant=?',o.tenantId)!.n}]));
      const sample={count,cpuMs:rows.reduce((n,r)=>n+r.cpuMs,0),p95WallMs:p95(rows.map(r=>r.wallMs)),maxRssBytesObserved:Math.max(...rows.map(r=>r.rssBytesObserved)),liveFiles,checkpointedFiles,perTenant,idle:{cycles:50,cpuMs:(idleCpu.user+idleCpu.system)/1000,wallMs:idleWallMs,processIoDelta:beforeIo&&idleIo?Object.fromEntries(Object.keys(beforeIo).map(k=>[k,idleIo[k]!-beforeIo[k]!])):null},rows};
      samples.push(sample);console.log(JSON.stringify({count,cpuMs:sample.cpuMs,p95WallMs:sample.p95WallMs,checkpointedBytes:Object.values(checkpointedFiles).reduce((a,b)=>a+b,0)}));
    }finally{await runtime.close();}
  }
  const report={schemaVersion:1,generatedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runnerSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),sourceSha256:Object.fromEntries(['store','engine','grants','service','notifications','profiles'].map(name=>[name,createHash('sha256').update(readFileSync(`src/delegation/phase05/${name}.ts`)).digest('hex')])),environment:{node:process.version,logicalCpus:cpus().length,cpuQuota:readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim()},scope:'Sequential valid-grant direct indexed-engine lifecycle; two synthetic tenants, injected memory-idempotent providers, controlled lost acknowledgments. Acceptance tests separately exercise OAuth, HTTP and SDK MCP.',measurement:{cpu:'Process user+system delta per sequential request; includes SQLite/fsync and test adapters',latency:'saveTurn/receive/claim/propose/tick/read incl controlled immediate retry, not SMS delivery or agent inference',io:'Linux /proc/self/io process counter deltas; native SQLite included; write_bytes is kernel accounting, not exact database amplification or storage device flush bytes',storage:'Physical SQLite/WAL/shared-memory file sizes before and after WAL checkpoint; index/page overhead included',memory:'Sampled whole-process RSS; maximum observed, not continuous peak or per-tenant allocation',idle:'50 engine and notification sweeps over retained completed work; no configured notification routes',externalInferenceCalls:0,realSmsCalls:0},limitations:['Single local Node process, no distributed/multi-host throughput claim','Sequential attribution does not measure concurrent per-tenant CPU','Process IO counters include incidental runtime activity and depend on filesystem/kernel accounting','Mock provider receipts use an in-memory map in this sampler; crash tests use durable engine records and separate fixtures','Different runtime/storage from previous JSON sample; observations do not establish a controlled hardware comparison'],samples};
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
}finally{rmSync(root,{recursive:true,force:true});}
