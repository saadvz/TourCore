// Standalone fixture proof of existing interfaces. No production source changes.
import assert from 'node:assert/strict';
import {randomBytes, createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {DelegationPrototype, LocalReplySink} from '../../src/delegation/prototype.ts';
import {delegationApp} from '../../src/delegation/mcp.ts';
import {DelegationNotifications} from '../../src/delegation/notifications.ts';
import {AgentProfiles} from '../../src/agents/registry.ts';
import {SmsProof,SMS_PROOF_TEXT} from '../../src/delegation/smsProof.ts';
import {hostedTenantDecision} from '../../src/install/tenant.ts';

const here=dirname(fileURLToPath(import.meta.url));
const output=process.argv[2] ?? join(here,'results/isolation.json');
const home=mkdtempSync(join(tmpdir(),'cleaner-phase05-'));
process.umask(0o077);
const checks=[]; const cleanups=[];
const A={tenantId:'landlord_a',agentId:'grok_client'};
const B={tenantId:'landlord_b',agentId:'grok_client'}; // Same agent name is deliberate.
const initial=Date.parse('2026-10-12T12:00:00Z');
const start='2026-10-13T14:00:00Z';
const iso=value=>new Date(value).toISOString();
const turn=(who,id='same_turn_id')=>({...who,id,version:1,recipient:`synthetic_${who.tenantId}_cleaner`,
  timeZone:who.tenantId===A.tenantId?'America/New_York':'Europe/London',
  windowStart:'2026-10-13T12:00:00Z',windowEnd:'2026-10-13T18:00:00Z',nextArrival:'2026-10-13T19:00:00Z',minimumMinutes:90});
// saveTurn has a strict schema; agentId is an auth identity, never booking data.
const booking=(who,id)=>{const {agentId,...value}=turn(who,id);return value;};
const incoming=(who,event,turnId='same_turn_id')=>({tenantId:who.tenantId,providerEventId:event,turnId,requestedStart:start});
async function probe(name,action,{gap=false}={}) {
  try {const details=await action();checks.push({name,status:gap?'known_gap':'passed',...(details?{details}:{})});}
  catch(error) {checks.push({name,status:'failed',errorCategory:error.constructor.name});}
}
async function denied(action,code) {
  try {await action();assert.fail('Unexpected cross-scope success');}
  catch(error) {assert.equal(error.code,code);}
}
async function request(client,name,args={},code) {
  let result;
  try {result=await client.callTool({name,arguments:args});}
  catch(error) {if(code==='INVALID_PARAMS'){assert.equal(error.code,-32602);return;}throw error;}
  if(code==='INVALID_PARAMS'){
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/Input validation error|MCP error -32602/);
    return {code:'INVALID_PARAMS'};
  }
  const value=JSON.parse(result.content[0].text);
  if(code){assert.equal(result.isError,true);assert.equal(value.code,code);return value;}
  assert.notEqual(result.isError,true);return value;
}
function setup(id,override) {
  const root=join(home,id);mkdirSync(root,{recursive:true});
  const clock={now:initial};const sink=new LocalReplySink(join(root,'replies.json'));
  let engine=new DelegationPrototype(root,override??sink,{now:()=>clock.now,leaseMs:1000,deadlineMs:10000,retryMs:10,sendTimeoutMs:30});
  return {root,clock,sink,get engine(){return engine;},restart(){engine=new DelegationPrototype(root,override??sink,{now:()=>clock.now,leaseMs:1000,deadlineMs:10000,retryMs:10,sendTimeoutMs:30});return engine;}};
}

let report;
try {
 const shared=setup('shared');await shared.engine.saveTurn(booking(A));await shared.engine.saveTurn(booking(B));
 const idA=await shared.engine.receive(incoming(A,'same_provider_event'));
 const idB=await shared.engine.receive(incoming(B,'same_provider_event'));
 const bindings=[A,B].map(who=>({...who,adapterId:'grok',token:randomBytes(32).toString('hex')}));
 const profiles=new AgentProfiles(shared.root,bindings,{now:()=>shared.clock.now,draftScenario:()=> 'overruns'});
 const app=delegationApp(shared.engine,bindings.map(({adapterId,...b})=>b),{profiles,allowedHosts:['127.0.0.1','localhost']});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 cleanups.push(()=>new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 const url=`http://127.0.0.1:${server.address().port}/mcp`;
 const clients=[];
 for(const binding of bindings){
  const c=new Client({name:'phase05-scripted-fixture',version:'1'});
  await c.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${binding.token}`}}}));
  clients.push(c);cleanups.push(()=>c.close());
 }
 const [clientA,clientB]=clients;
 await probe('tenant-qualified source IDs, shared booking IDs and recipient separation',async()=>{
  assert.notEqual(idA,idB);assert.equal(await shared.engine.receive(incoming(A,'same_provider_event')),idA);
  assert.equal(await shared.engine.receive(incoming(B,'same_provider_event')),idB);
  assert.equal((await shared.engine.get(A,idA)).turn.id,(await shared.engine.get(B,idB)).turn.id);
  assert.equal(JSON.parse(readFileSync(join(shared.root,'delegation.json'))).turns.length,2);
 });
 await probe('actual SDK discovery of all eight tools for both authenticated tenants',async()=>{
  for(const c of clients)assert.equal((await c.listTools()).tools.length,8);
 });
 await probe('MCP list/read returns only own work and excludes recipient/lease credentials',async()=>{
  for(const [c,id,foreign] of [[clientA,idA,idB],[clientB,idB,idA]]){
   assert.deepEqual((await request(c,'list_delegated_work')).map(w=>w.id),[id]);
   const view=await request(c,'read_delegated_work',{id});
   assert.ok(!('recipient' in view.turn));assert.ok(!('tenantId' in view.turn));assert.ok(!('leaseToken' in view));
   await request(c,'read_delegated_work',{id:foreign},'NOT_FOUND');
  }
 });
 await probe('cross-tenant claims and operator evidence are denied',async()=>{
  await request(clientA,'claim_delegated_work',{id:idB},'NOT_FOUND');
  await request(clientB,'claim_delegated_work',{id:idA},'NOT_FOUND');
  await denied(()=>shared.engine.evidence(A,idB),'NOT_FOUND');await denied(()=>shared.engine.evidence(B,idA),'NOT_FOUND');
 });
 await probe('tenant injection rejected by each applicable strict MCP schema',async()=>{
  for(const [name,args] of [['list_delegated_work',{}],['read_delegated_work',{id:idA}],['claim_delegated_work',{id:idA}],
    ['read_agent_profile',{}],['declare_agent_capabilities',{capabilities:[]}],['begin_agent_probe',{capability:'mcp_tools'}]])
   await request(clientA,name,{...args,tenantId:B.tenantId},'INVALID_PARAMS');
 });
 await probe('invalid bearer and untrusted host rejected by real HTTP route',async()=>{
  const h={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'});
  assert.equal((await fetch(url,{method:'POST',headers:h,body})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers:{...h,Authorization:'Bearer fixture_not_authorized'},body})).status,401);
  const rejectedHost=await new Promise((resolve,reject)=>{
   const req=httpRequest(url,{method:'POST',headers:{...h,Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});
   req.on('error',reject);req.end(body);
  });
  assert.equal(rejectedHost,403);
  return {missingOrInvalidBearerStatus:401,untrustedHostStatus:rejectedHost};
 });
 await probe('separate profile declarations despite identical agent IDs',async()=>{
  await request(clientA,'declare_agent_capabilities',{capabilities:[{capability:'generation_reasoning',availability:'available'}]});
  const a=await request(clientA,'read_agent_profile');const b=await request(clientB,'read_agent_profile');
  assert.equal(a.tenantId,A.tenantId);assert.equal(b.tenantId,B.tenantId);
  assert.equal(a.capabilities.find(c=>c.capability==='generation_reasoning').declared,'available');
  assert.equal(b.capabilities.find(c=>c.capability==='generation_reasoning').declared,'unknown');
 });
 await probe('cross-tenant nonce/probe completion denied; each own MCP probe succeeds',async()=>{
  const a=await request(clientA,'begin_agent_probe',{capability:'mcp_tools'});
  const b=await request(clientB,'begin_agent_probe',{capability:'mcp_tools'});
  await request(clientB,'complete_agent_probe',{probeId:a.probeId,nonce:a.nonce},'NOT_FOUND');
  await request(clientA,'complete_agent_probe',{probeId:b.probeId,nonce:b.nonce},'NOT_FOUND');
  await request(clientA,'complete_agent_probe',{probeId:a.probeId,nonce:a.nonce,tenantId:B.tenantId},'INVALID_PARAMS');
  assert.equal((await request(clientA,'complete_agent_probe',{probeId:a.probeId,nonce:a.nonce})).status,'verified');
  assert.equal((await request(clientB,'complete_agent_probe',{probeId:b.probeId,nonce:b.nonce})).status,'verified');
 });
 const ca=await request(clientA,'claim_delegated_work',{id:idA});const cb=await request(clientB,'claim_delegated_work',{id:idB});
 const proposal=(id,claim)=>({id,leaseToken:claim.leaseToken,actionKey:'same_action_key',expectedTurnVersion:claim.turn.version,start});
 await probe('foreign work or lease cannot authorize either tenant proposal',async()=>{
  await request(clientA,'propose_cleaning_time',proposal(idB,cb),'NOT_FOUND');
  await request(clientB,'propose_cleaning_time',proposal(idA,ca),'NOT_FOUND');
  await request(clientA,'propose_cleaning_time',{...proposal(idA,ca),leaseToken:cb.leaseToken},'LEASE_INVALID');
  await request(clientB,'propose_cleaning_time',{...proposal(idB,cb),leaseToken:ca.leaseToken},'LEASE_INVALID');
  await request(clientA,'propose_cleaning_time',{...proposal(idA,ca),tenantId:B.tenantId},'INVALID_PARAMS');
 });
 await probe('two tenants complete with same action key and distinct fixed recipient replies',async()=>{
  await Promise.all([request(clientA,'propose_cleaning_time',proposal(idA,ca)),request(clientB,'propose_cleaning_time',proposal(idB,cb))]);
  await shared.engine.tick();
  for(const [c,id] of [[clientA,idA],[clientB,idB]])assert.equal((await request(c,'read_delegated_work',{id})).status,'completed');
  const replies=shared.sink.replies();assert.equal(replies.length,2);
  for(const who of [A,B])assert.equal(replies.find(r=>r.tenantId===who.tenantId).recipient,booking(who).recipient);
  const snapshot=readFileSync(join(shared.root,'delegation.json'),'utf8');
  await request(clientA,'propose_cleaning_time',proposal(idA,ca));await request(clientB,'propose_cleaning_time',proposal(idB,cb));
  await shared.engine.tick();assert.equal(readFileSync(join(shared.root,'delegation.json'),'utf8'),snapshot);
  return {repliesPerTenant:1,status:'completed',decisionSource:'agent',deliveryStatus:'sent',provider:'local_simulation'};
 });
 await probe('credential rotation invalidates only the changed tenant profile evidence',async()=>{
  const rotated=[{...bindings[0],token:randomBytes(32).toString('hex')},bindings[1]];
  const renewed=new AgentProfiles(shared.root,rotated,{now:()=>shared.clock.now});
  assert.ok(!(await renewed.get(A)).capabilities.find(c=>c.capability==='mcp_tools').evidence);
  assert.equal((await renewed.get(B)).capabilities.find(c=>c.capability==='mcp_tools').evidence.status,'verified');
  return {profileEvidenceInvalidation:true,liveMcpTokenRevocationTested:false};
 });
 await probe('profile-only credential rotation does not revoke the already-running MCP binding',async()=>{
  assert.equal((await request(clientA,'read_delegated_work',{id:idA})).status,'completed');
  return {finding:'Old bearer still reaches its scoped work after profile credential evidence changes. The MCP binding list is separate and requires replacement/restart; hot revocation is not implemented.',
   crossTenantAccessObserved:false,scope:'Local SDK fixture, not a live Grok credential change'};
 },{gap:true});
 await probe('same-directory notification workers conflict when another tenant has pending wakeup',async()=>{
  const h=setup('shared_notifications');for(const who of [A,B])await h.engine.saveTurn(booking(who));
  const ia=await h.engine.receive(incoming(A,'notify'));await h.engine.receive(incoming(B,'notify'));
  const settings={url:'https://fixture.example/notify',authorization:'Bearer synthetic_fixture'};
  const a=new DelegationNotifications(h.root,h.engine,A,settings,{now:()=>h.clock.now,fetch:async()=>new Response(null,{status:503})});
  const b=new DelegationNotifications(h.root,h.engine,B,settings,{now:()=>h.clock.now,fetch:async()=>new Response(null,{status:200})});
  await a.tick();assert.equal((await a.status(ia)).status,'pending');
  await denied(()=>b.tick(),'NOT_FOUND');
  assert.equal((await b.status(ia)).workId,ia);
  return {finding:'Shared notifications.json is not tenant-partitioned; second worker fails on foreign pending work. Internal status lookup is also unscoped.',liveExternalDataExposureProven:false};
 },{gap:true});
 await probe('tenant-specific notification directories isolate settings and provider-event IDs',async()=>{
  const h=setup('separate_notifications');const ids=[];
  for(const who of [A,B]){await h.engine.saveTurn(booking(who));ids.push(await h.engine.receive(incoming(who,'same_notification_event')));}
  for(const [index,who] of [A,B].entries()){
   const root=join(h.root,who.tenantId);mkdirSync(root);
   const auth=`Bearer ${randomBytes(32).toString('hex')}`;let attempts=0;
   const n=new DelegationNotifications(root,h.engine,who,{url:`https://${who.tenantId}.example/notify`,authorization:auth},{now:()=>h.clock.now,fetch:async(url,init)=>{
    assert.equal(url,`https://${who.tenantId}.example/notify`);assert.equal(init.headers.Authorization,auth);
    assert.equal(JSON.parse(init.body).workId,ids[index]);attempts++;return new Response(null,{status:200});
   }});
   await n.tick();assert.equal(attempts,1);assert.equal((await n.status(ids[index])).status,'accepted');
   assert.equal((await n.status(ids[1-index])).status,'not_queued');
  }
  return {scope:'Existing notification components explicitly composed with separate fixture directories; deployed service does not implement this tenancy configuration',network:'Injected simulation only'};
 });
 await probe('restart preserves lease expiry/deadline and rejects old lease after reclaim',async()=>{
  const h=setup('recovery');await h.engine.saveTurn(booking(A));const id=await h.engine.receive(incoming(A,'restart'));
  const first=await h.engine.claim(A,id);const deadline=first.deadlineAt;
  h.clock.now+=1000;h.restart();const fresh=await h.engine.claim(A,id);
  assert.notEqual(first.leaseToken,fresh.leaseToken);assert.equal(fresh.deadlineAt,deadline);
  await denied(()=>h.engine.propose(A,proposal(id,first)),'LEASE_INVALID');
  h.clock.now=initial+10000;h.restart();await h.engine.tick();
  assert.equal((await h.engine.get(A,id)).decisionSource,'fallback');assert.equal(h.sink.replies().length,1);
 });
 await probe('concurrent same-agent proposals commit once and competing agent cannot take lease',async()=>{
  const h=setup('concurrency');await h.engine.saveTurn(booking(A));const id=await h.engine.receive(incoming(A,'concurrent'));
  const first=await h.engine.claim(A,id);await denied(()=>h.engine.claim({...A,agentId:'other_agent'},id),'LEASE_BUSY');
  await Promise.all([h.engine.propose(A,proposal(id,first)),h.engine.propose(A,proposal(id,first))]);
  await Promise.all([h.engine.tick(),h.engine.tick()]);assert.equal(h.sink.replies().length,1);
  assert.equal((await h.engine.get(A,id)).turn.version,2);
 });
 await probe('ambiguous non-idempotent provider outcome enters review without automatic resend',async()=>{
  let sends=0;const h=setup('ambiguous',{idempotent:false,send:async()=>{sends++;throw new Error('Fixture uncertain acknowledgment');}});
  await h.engine.saveTurn(booking(A));const id=await h.engine.receive(incoming(A,'ambiguous'));
  const claim=await h.engine.claim(A,id);await h.engine.propose(A,proposal(id,claim));await h.engine.tick();
  h.restart();await h.engine.tick();assert.equal(sends,1);assert.equal((await h.engine.get(A,id)).status,'review_required');
 });
 await probe('global serialized provider send blocks unrelated tenant reads',async()=>{
  let release,entered;const waiting=new Promise(resolve=>{release=resolve;});const enteredSend=new Promise(resolve=>{entered=resolve;});
  const h=setup('blocking',{idempotent:true,send:async()=>{entered();await waiting;return {receipt:'fixture_receipt'};}});
  for(const who of [A,B])await h.engine.saveTurn(booking(who));
  const ia=await h.engine.receive(incoming(A,'blocking'));const ib=await h.engine.receive(incoming(B,'blocking'));
  const claim=await h.engine.claim(A,ia);await h.engine.propose(A,proposal(ia,claim));
  const sweep=h.engine.tick();await enteredSend;let readCompleted=false;
  const read=h.engine.get(B,ib).then(()=>{readCompleted=true;});
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(readCompleted,false);
  release();await sweep;await read;
  return {finding:'Provider await holds the single global engine queue. A slow tenant blocks unrelated tenant work until send completes/times out.',syntheticBlockedObservationMs:5,productionLatencyClaim:false};
 },{gap:true});
 await probe('hosted demo tenant policy rejects a second landlord rather than hosting both',async()=>{
  const state={hostedTenant:{clientId:'client_a',boundAt:iso(initial)}};
  assert.equal(hostedTenantDecision(state,'client_a').allowed,true);
  assert.equal(hostedTenantDecision(state,'client_b').allowed,false);
  return {finding:'Existing hosted OAuth installation policy deliberately supports one client only.',scope:'Policy function, not a full OAuth authorization flow'};
 },{gap:true});
 await probe('two SMS proof adapters do not resolve distinct landlords in a shared engine',async()=>{
  const h=setup('sms_bindings');let sends=0;const work=[];
  const sid='SM'+'a'.repeat(32);
  for(const [i,who] of [A,B].entries()){
   const root=join(h.root,who.tenantId);mkdirSync(root);
   const settings={accountSid:'AC'+String(i+1).repeat(32),authToken:randomBytes(32).toString('hex'),
    fromNumber:`+1202555010${i}`,testNumber:`+1202555011${i}`,publicBaseUrl:`https://${who.tenantId}.example`};
   const sms=new SmsProof(root,settings,{now:()=>h.clock.now,client:{sendSms:async()=>{sends++;throw new Error('Real sends forbidden');}}});
   work.push(await sms.receive(h.engine,{From:settings.testNumber,To:settings.fromNumber,Body:SMS_PROOF_TEXT,MessageSid:sid,NumMedia:'0'}));
  }
  assert.equal(work[0].id,work[1].id);assert.equal(sends,0);
  const state=JSON.parse(readFileSync(join(h.root,'delegation.json'),'utf8'));
  assert.equal(state.work.length,1);assert.equal(state.work[0].tenantId,'synthetic_host');
  return {finding:'SMS proof fixes tenant to synthetic_host; distinct fixture account/number settings do not create landlord tenant bindings.',sameSourceIdAcrossFixturesMerged:true,
   scope:'Trusted receive APIs with fictional numbers and injected clients; signature/HTTP ingress and real providers not exercised'};
 },{gap:true});
 report={schemaVersion:1,scope:'One-process two-tenant existing delegation/MCP/profile components, scripted SDK clients and local/injected providers only',
  sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),generatedAt:iso(Date.now()),
  runnerSha256:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),checks,
  summary:{passed:checks.filter(c=>c.status==='passed').length,knownGaps:checks.filter(c=>c.status==='known_gap').length,failed:checks.filter(c=>c.status==='failed').length},
  productionReady:false,costAnalysis:'Deferred by user; current hosting service is not the final deployment choice',
  notMeasured:['Actual Grok background execution with two landlords','OAuth tenant isolation','Real SMS provider credential/number routing','Production properties and access records','Tenant-aware admin/event endpoints','Enforced per-tenant rate limits and budgets','Production hot token revocation'],
  fixtureSecretPolicy:'Bearer credentials and probe nonces remain in memory and are omitted from reports. Temporary runtime fixtures hold lease tokens/nonce hashes for recovery; all fixture files are removed after the run.'};
} finally {
 for(const cleanup of cleanups.reverse())await cleanup();
 rmSync(home,{recursive:true,force:true});
}
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.summary));if(report.summary.failed)process.exitCode=1;
