// Sequential resource observations of existing prototype APIs, not cloud billing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir, cpus} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DelegationPrototype, LocalReplySink} from '../../src/delegation/prototype.ts';
import {DelegationNotifications} from '../../src/delegation/notifications.ts';

const here=dirname(fileURLToPath(import.meta.url));
const output=process.argv[2]??join(here,'results/resource-sample.json');
const home=fs.mkdtempSync(join(tmpdir(),'cleaner-phase05-meter-'));process.umask(0o077);
const original={openSync:fs.openSync,writeSync:fs.writeSync,closeSync:fs.closeSync,fsyncSync:fs.fsyncSync,renameSync:fs.renameSync};
const fds=new Set();let actor,bytes=0,writes=0,flushes=0,renames=0;
// Trace only files below this run's temporary fixture root. Restore all hooks.
fs.openSync=function(path,...args){const fd=original.openSync(path,...args);if(resolve(String(path)).startsWith(home+'/'))fds.add(fd);return fd;};
fs.writeSync=function(fd,...args){const written=original.writeSync(fd,...args);if(actor&&fds.has(fd)){bytes+=written;writes++;}return written;};
fs.fsyncSync=function(fd){if(actor&&fds.has(fd))flushes++;return original.fsyncSync(fd);};
fs.closeSync=function(fd){fds.delete(fd);return original.closeSync(fd);};
fs.renameSync=function(from,to){if(actor&&resolve(String(from)).startsWith(home+'/'))renames++;return original.renameSync(from,to);};
syncBuiltinESMExports();
const quantile=(a,q)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*q)-1];
const samples=[];
let report;
try {
 for(const count of [20,100,300]){
  const root=join(home,`sample_${count}`);fs.mkdirSync(root);
  const base=Date.parse('2026-10-12T12:00:00Z');const clock={now:base};
  const local=new LocalReplySink(join(root,'replies.json'));
  const attempts=new Map();
  const provider={idempotent:true,send:async reply=>{
   const attempt=(attempts.get(reply.key)??0)+1;attempts.set(reply.key,attempt);
   const receipt=await local.send(reply);
   // Every tenth A event loses its first ack after one durable local delivery.
   if(reply.tenantId==='landlord_a'&&actor.injectLostAck&&attempt===1)throw new Error('Fixture lost acknowledgment');
   return receipt;
  }};
  const engine=new DelegationPrototype(root,provider,{now:()=>clock.now,retryMs:1});
  const rows=[];let maxRss=process.memoryUsage().rss;
  for(let i=0;i<count;i++){
   const tenantId=i%2===0?'landlord_a':'landlord_b';const tenantIndex=Math.floor(i/2);
   const identity={tenantId,agentId:'scripted_fixture'};const turnId=`turn_${tenantIndex}`;
   actor={tenantId,injectLostAck:tenantId==='landlord_a'&&tenantIndex%10===0};bytes=0;writes=0;flushes=0;renames=0;
   const cpu=process.cpuUsage();const started=performance.now();
   await engine.saveTurn({tenantId,id:turnId,version:1,recipient:`synthetic_${tenantId}_cleaner`,timeZone:'America/New_York',
    windowStart:'2026-10-13T12:00:00Z',windowEnd:'2026-10-13T18:00:00Z',nextArrival:'2026-10-13T19:00:00Z',minimumMinutes:90});
   const id=await engine.receive({tenantId,providerEventId:`event_${tenantIndex}`,turnId,requestedStart:'2026-10-13T14:00:00Z'});
   const claim=await engine.claim(identity,id);
   await engine.propose(identity,{id,leaseToken:claim.leaseToken,actionKey:`action_${tenantIndex}`,expectedTurnVersion:claim.turn.version,start:claim.requestedStart});
   await engine.tick();if(actor.injectLostAck){clock.now++;await engine.tick();}
   assert.equal((await engine.get(identity,id)).status,'completed');
   const used=process.cpuUsage(cpu),wall=performance.now()-started;const rss=process.memoryUsage().rss;maxRss=Math.max(maxRss,rss);
   rows.push({tenantId,wallMs:wall,cpuMs:(used.user+used.system)/1000,atomicWriteBytes:bytes,writeCalls:writes,fsyncCalls:flushes,atomicRenames:renames,
    simulatedProviderAttempts:attempts.get(`reply_${id}`),retryAttempts:attempts.get(`reply_${id}`)-1,rssBytesObserved:rss});
   actor=undefined;
  }
  const state=JSON.parse(fs.readFileSync(join(root,'delegation.json'),'utf8'));
  const replies=local.replies();assert.equal(state.work.length,count);assert.equal(replies.length,count);
  const notifiers=['landlord_a','landlord_b'].map(tenantId=>{
   const path=join(root,tenantId);fs.mkdirSync(path);
   return new DelegationNotifications(path,engine,{tenantId,agentId:'scripted_fixture'},
    {url:'https://fixture.example/never_called',authorization:'Bearer synthetic_fixture'},
    {now:()=>clock.now,fetch:async()=>{throw new Error('Completed-work idle sweep must not send a webhook');}});
  });
  const idleCpu=process.cpuUsage();const idleStart=performance.now();
  for(let cycle=0;cycle<50;cycle++){await engine.tick();for(const notify of notifiers)await notify.tick();}
  const idleUsed=process.cpuUsage(idleCpu);
  const idle={cycles:50,engineSweepsPerCycle:1,tenantNotificationSweepsPerCycle:2,
   cpuMs:(idleUsed.user+idleUsed.system)/1000,wallMs:performance.now()-idleStart,networkAttempts:0,
   note:'Completed retained history only; no external agent, queued work or sends'};
  function summary(subset){return {count:subset.length,cpuMs:subset.reduce((n,r)=>n+r.cpuMs,0),
   wallMs:subset.reduce((n,r)=>n+r.wallMs,0),p50WallMs:quantile(subset.map(r=>r.wallMs),.5),p95WallMs:quantile(subset.map(r=>r.wallMs),.95),
   atomicWriteBytes:subset.reduce((n,r)=>n+r.atomicWriteBytes,0),fsyncCalls:subset.reduce((n,r)=>n+r.fsyncCalls,0),
   simulatedProviderAttempts:subset.reduce((n,r)=>n+r.simulatedProviderAttempts,0),retryAttempts:subset.reduce((n,r)=>n+r.retryAttempts,0)};}
  const perTenant=Object.fromEntries(['landlord_a','landlord_b'].map(tenant=>[tenant,{...summary(rows.filter(r=>r.tenantId===tenant)),
   compactWorkJsonBytes:Buffer.byteLength(JSON.stringify(state.work.filter(w=>w.tenantId===tenant))),
   compactTurnJsonBytes:Buffer.byteLength(JSON.stringify(state.turns.filter(t=>t.tenantId===tenant))),
   compactReplyJsonBytes:Buffer.byteLength(JSON.stringify(replies.filter(r=>r.tenantId===tenant)))}]));
  const record={count,...summary(rows),perTenant,maxRssBytesObserved:maxRss,idle,
   retainedFiles:{'delegation.json':fs.statSync(join(root,'delegation.json')).size,'replies.json':fs.statSync(join(root,'replies.json')).size},
   lastTwenty:summary(rows.slice(-20)),rows};
  samples.push(record);console.log(JSON.stringify({count,cpuMs:record.cpuMs,p95WallMs:record.p95WallMs,retainedBytes:Object.values(record.retainedFiles).reduce((a,b)=>a+b,0),writeBytes:record.atomicWriteBytes}));
 }
 report={schemaVersion:1,generatedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  runnerSha256:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  scope:'Sequential direct existing-engine lifecycle APIs, shared single-writer JSON store, two synthetic tenants, idempotent local simulated provider; no hosted billing, MCP transport or Grok reasoning included',
  measurement:{cpu:'Process user+system CPU deltas per sequential known-tenant request, milliseconds',memory:'Sampled whole-process RSS; maximum observed, not a continuous peak or per-tenant memory bill',
   storage:'Actual end-of-run physical file sizes; per-tenant compact JSON byte contributions are logical sizes, not allocated physical storage',
   io:'Returned writeSync bytes, fsync and rename calls restricted to temporary fixture files; retries included',
   latency:'saveTurn/receive/claim/propose/tick/read wall time, including fsync and controlled immediate retries; not real SMS or live-agent latency',
   retry:'One lost acknowledgment for every tenth A request after a persisted local delivery; idempotent retries reuse the same key',externalInferenceApiCalls:0,realSmsProviderApiCalls:0},
  costAnalysis:'Deferred by user; resource data is performance evidence, not a hosting cost estimate',
  environment:{node:process.version,logicalCpus:cpus().length,cpuQuota:fs.existsSync('/sys/fs/cgroup/cpu.max')?fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim():null},
  limitations:['No enforced per-tenant budget/rate limiter exists in this demo','No property/access/OAuth/provider-credential production tenancy is tested','Sequential actor attribution is not concurrent production metering','Global JSON snapshots grow with all retained tenant histories; extrapolating constant per-message CPU to production is unsupported','Sampled RSS includes Node/tsx/dependency overhead; no per-tenant baseline/idle allocation measured'],samples};
} finally {
 for(const [name,value] of Object.entries(original))fs[name]=value;syncBuiltinESMExports();
 fs.rmSync(home,{recursive:true,force:true});
}
fs.mkdirSync(dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
