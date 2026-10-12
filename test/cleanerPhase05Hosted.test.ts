import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHostedPhase05Test, phase05TestConfig } from '../src/delegation/phase05/hostedTest';
import type { FixtureTimers } from '../src/delegation/phase05/testSchedules';
const cleanup:Array<()=>unknown|Promise<unknown>>=[];afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
const credential=()=>randomBytes(32).toString('hex');
async function setup(options:{fixtureTimers?:FixtureTimers}={}) {
  mkdirSync('work',{recursive:true});const root=mkdtempSync(join(process.cwd(),'work','hosted-phase05-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const env={CLEANER_TEST_HOME:root,CLEANER_TEST_PUBLIC_URL:'https://cleaner-test.example',CLEANER_TEST_HOST:'0.0.0.0',CLEANER_TEST_AGENT_TOKEN:credential(),CLEANER_TEST_ADMIN_TOKEN:credential(),CLEANER_PHASE05_TENANT_B_AGENT_TOKEN:credential(),CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN:credential(),CLEANER_TEST_SMS_ENABLED:'true',CLEANER_TEST_TWILIO_ACCOUNT_SID:'real-settings-must-not-be-used',CLEANER_TEST_TWILIO_AUTH_TOKEN:'not-to-be-used',CLEANER_TEST_TWILIO_FROM_NUMBER:'not-to-be-used',CLEANER_TEST_SMS_TEST_NUMBER:'not-to-be-used',CLEANER_TEST_WEBHOOK_URL:'https://injected.example/receiver',CLEANER_TEST_WEBHOOK_AUTH:'Bearer synthetic-test-receiver'};
  const clock={now:Date.parse('2026-10-12T12:00:00Z')};const config=phase05TestConfig(env);
  const runtime=createHostedPhase05Test(config,{now:()=>clock.now,workerIntervalMs:0,fetch:async()=>new Response('',{status:202}),railwayHealthcheck:true,...options});cleanup.push(()=>runtime.close());
  const server=await new Promise<Server>(resolve=>{const s=runtime.app.listen(0,'127.0.0.1',()=>resolve(s));});cleanup.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const http=async(path:string,token:string,body?:unknown,method=body?'POST':'GET')=>{const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,value:await response.json() as any};};
  const connect=async(token:string)=>{const client=new Client({name:'synthetic-existing-cleaner-connector',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));cleanup.push(()=>client.close());return {client,call:async(name:string,args:Record<string,unknown>={})=>{const r=await client.callTool({name,arguments:args});return JSON.parse((r.content as Array<{text:string}>)[0]!.text);}};};
  return {env,config,runtime,clock,base,http,connect,root};
}
it('reuses one endpoint for two credential-scoped tenants; ignores real SMS settings and persists simulated receipts',async()=>{
  const h=await setup(),admins=[h.env.CLEANER_TEST_ADMIN_TOKEN,h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN],tokens=[h.env.CLEANER_TEST_AGENT_TOKEN,h.env.CLEANER_PHASE05_TENANT_B_AGENT_TOKEN],agents=[await h.connect(tokens[0]!),await h.connect(tokens[1]!)];
  expect(h.config.sms).toBeUndefined();expect((await h.http('/test/runtime',admins[0]!)).value).toMatchObject({tenants:2,realSmsEnabled:false});
  const ids=[];
  for(let n=0;n<2;n++) {
    const event=await h.http('/test/events',admins[n]!,{eventId:'shared_live_fixture'});expect(event.status).toBe(200);expect(event.value.mode).toBe('synthetic');ids.push(event.value.work.id);
    expect((await h.http('/test/events',admins[n]!,{eventId:'shared_live_fixture'})).value.work.id).toBe(ids[n]);
    expect((await h.http('/test/events',admins[n]!,{eventId:'injected',tenantId:n?'A':'B'})).status).toBe(400);
    expect((await h.http('/test/events',tokens[n]!,{eventId:'agent_cannot_inject'})).status).toBe(401);
    const probe=await h.http('/owner/agents/grok_test_agent/probes/core-mcp',admins[n]!,{workId:ids[n]});expect(probe.status).toBe(200);
    await agents[n]!.call('read_delegated_work',{id:ids[n]});
    expect((await h.http('/owner/agents/grok_test_agent/profile',admins[n]!)).value.capabilities.find((c:any)=>c.capability==='mcp_tools').status).toBe('verified');
    const claim=await agents[n]!.call('claim_delegated_work',{id:ids[n]});await agents[n]!.call('propose_cleaning_time',{id:ids[n],leaseToken:claim.leaseToken,expectedTurnVersion:claim.turn.version,start:claim.requestedStart,actionKey:'same_action'});
  }
  expect(ids[0]).not.toBe(ids[1]);
  for(let n=0;n<2;n++) {expect((await agents[n]!.call('read_delegated_work',{id:ids[1-n]})).code).toBe('NOT_FOUND');expect((await h.http(`/test/evidence/${ids[1-n]}`,admins[n]!)).status).toBe(404);}
  await h.runtime.engine.tick();
  for(let n=0;n<2;n++){const evidence=(await h.http(`/test/evidence/${ids[n]}`,admins[n]!)).value;expect(evidence.work.status).toBe('completed');expect(evidence.replies).toHaveLength(1);expect(evidence.replies[0].recipient).toBe(n?'synthetic_cleaner_B':'synthetic_cleaner_A');expect(evidence.carrierDelivery).toContain('simulated');}
  const restarted=createHostedPhase05Test(h.config,{now:()=>h.clock.now,workerIntervalMs:0,fetch:async()=>new Response('',{status:202})});cleanup.push(()=>restarted.close());await restarted.engine.tick();
  expect(restarted.store.one<{n:number}>('SELECT COUNT(*) n FROM simulated_provider_receipts')!.n).toBe(2);
});
it('never resurrects a revoked bootstrap agent token on restart and denies owner HTTP substitutes for MCP evidence',async()=>{
  const h=await setup(),admin=h.runtime.grants.resolve(`Bearer ${h.env.CLEANER_TEST_ADMIN_TOKEN}`,'owner'),old=h.runtime.grants.resolve(`Bearer ${h.env.CLEANER_TEST_AGENT_TOKEN}`,'agent');
  const event=(await h.http('/test/events',h.env.CLEANER_TEST_ADMIN_TOKEN,{eventId:'scope_probe'})).value;
  await h.http('/owner/agents/grok_test_agent/probes/core-mcp',h.env.CLEANER_TEST_ADMIN_TOKEN,{workId:event.work.id});
  await h.http(`/test/evidence/${event.work.id}`,h.env.CLEANER_TEST_ADMIN_TOKEN);
  expect((await h.http('/owner/agents/grok_test_agent/profile',h.env.CLEANER_TEST_ADMIN_TOKEN)).value.capabilities.find((c:any)=>c.capability==='mcp_tools').status).toBe('unknown');
  h.runtime.grants.revoke(admin,old.grantId);
  const restarted=createHostedPhase05Test(h.config,{now:()=>h.clock.now,workerIntervalMs:0});cleanup.push(()=>restarted.close());
  expect(()=>restarted.grants.resolve(`Bearer ${h.env.CLEANER_TEST_AGENT_TOKEN}`,'agent')).toThrow();
  expect(restarted.grants.resolve(`Bearer ${h.env.CLEANER_PHASE05_TENANT_B_AGENT_TOKEN}`,'agent').tenantId).toBe('B');
});
it('requires four separate test credentials and rejects an untrusted public origin',async()=>{
  const h=await setup();expect(()=>phase05TestConfig({...h.env,CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN:h.env.CLEANER_TEST_ADMIN_TOKEN})).toThrow('Four distinct');
  expect(()=>phase05TestConfig({...h.env,CLEANER_TEST_PUBLIC_URL:'http://unsafe.example'})).toThrow('HTTPS');
  const rejected=await fetch(h.base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${h.env.CLEANER_TEST_AGENT_TOKEN}`,Host:'untrusted.example'},body:'{}'});expect(rejected.status).toBeGreaterThanOrEqual(400);
});

it('schedules both tenants through owner HTTP and atomically prepares native onboarding before any further client setup call',async()=>{
  const h=await setup(),admins=[h.env.CLEANER_TEST_ADMIN_TOKEN,h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN],tokens=[h.env.CLEANER_TEST_AGENT_TOKEN,h.env.CLEANER_PHASE05_TENANT_B_AGENT_TOKEN];
  const queued=await Promise.all(admins.map(token=>h.http('/test/schedules',token,{eventId:'same_server_clock_fixture',delaySeconds:300})));
  for(const q of queued)expect(q).toMatchObject({status:202,value:{mode:'synthetic',schedule:{status:'scheduled',workId:null}}});
  expect(queued[0]!.value.schedule.id).not.toBe(queued[1]!.value.schedule.id);
  expect((await h.http(`/test/schedules/${queued[1]!.value.schedule.id}`,admins[0]!)).status).toBe(404);
  expect((await h.http(`/test/schedules/${queued[0]!.value.schedule.id}`,admins[1]!,undefined,'DELETE')).status).toBe(404);
  expect((await h.http('/test/schedules',tokens[0]!,{eventId:'agent_cannot_schedule'})).status).toBe(401);
  expect((await h.http('/test/schedules',admins[0]!,{eventId:'body_cannot_select_authority',tenantId:'B'})).status).toBe(400);
  expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM work')!.n).toBe(0);
  h.clock.now+=300000;h.runtime.pumpScheduledFixtures();await h.runtime.notifications.tick();
  const ids=[];
  for(let n=0;n<2;n++) {
    const job=(await h.http(`/test/schedules/${queued[n]!.value.schedule.id}`,admins[n]!)).value.schedule;
    expect(job.status).toBe('fired');ids.push(job.workId);
    const client=await h.connect(tokens[n]!);expect((await client.call('read_agent_profile')).tenantId).toBe(n?'B':'A');
    const read=await client.call('read_delegated_work',{id:job.workId});
    expect(Date.parse(read.deadlineAt)-Date.parse(read.receivedAt)).toBe(120000);
    expect(Date.parse(read.receivedAt)).toBe(h.clock.now);
    const claimed=await client.call('claim_delegated_work',{id:job.workId});
    await client.call('propose_cleaning_time',{id:job.workId,leaseToken:claimed.leaseToken,expectedTurnVersion:claimed.turn.version,start:claimed.requestedStart,actionKey:'server_clock_native_action'});
  }
  await h.runtime.engine.tick();
  for(let n=0;n<2;n++) {
    const evidence=(await h.http(`/test/evidence/${ids[n]}`,admins[n]!)).value;
    expect(evidence).toMatchObject({work:{status:'completed',decisionSource:'agent'},notification:{status:'accepted',attempts:1}});expect(evidence.replies).toHaveLength(1);
    const verified=await h.http('/owner/agents/grok_test_agent/verify-workflow',admins[n]!,{workId:ids[n],conversationClosed:true});
    expect(verified.status).toBe(200);expect(verified.value.readiness.executionMode).toBe('autonomous');
    const replay=await h.http('/test/schedules',admins[n]!,{eventId:'same_server_clock_fixture',delaySeconds:300});
    expect(replay.value.schedule).toMatchObject({status:'fired',id:queued[n]!.value.schedule.id,runAt:queued[n]!.value.schedule.runAt,workId:ids[n]});
  }
  h.runtime.pumpScheduledFixtures();expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM probes')!.n).toBe(2);
  expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM simulated_provider_receipts')!.n).toBe(2);
});

it('fires from a server timer while the caller makes no later fixture, probe or notification requests',async()=>{
  const callbacks:Array<{callback:()=>void;delay:number;cleared:boolean}>=[];
  const timers:FixtureTimers={set:(callback,delay)=>{const t={callback,delay,cleared:false};callbacks.push(t);return t as unknown as ReturnType<typeof setTimeout>;},clear:timer=>{(timer as unknown as {cleared:boolean}).cleared=true;}};
  const h=await setup({fixtureTimers:timers});h.runtime.schedules.start();
  const job=(await h.http('/test/schedules',h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN,{eventId:'independent_server_timer'})).value.schedule;
  expect(callbacks.at(-1)!.delay).toBe(300000);
  h.clock.now+=300000;callbacks.at(-1)!.callback();
  const fired=(await h.http(`/test/schedules/${job.id}`,h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN)).value.schedule;
  expect(fired.status).toBe('fired');expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM probes')!.n).toBe(1);
  expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM notifications')!.n).toBe(1);
  expect((await h.http('/test/runtime',h.env.CLEANER_TEST_ADMIN_TOKEN)).value).toMatchObject({fixtureSchedulerVersion:'server-clock-v1',fixtureSchedulerHealthy:true});
});

it('retains queued jobs across restart and never recreates a fired source or setup records',async()=>{
  const h=await setup(),token=h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN;
  const job=(await h.http('/test/schedules',token,{eventId:'durable_clock_fixture'})).value.schedule;
  await h.runtime.close();h.clock.now+=300000;
  const restart=()=>{const r=createHostedPhase05Test(h.config,{now:()=>h.clock.now,workerIntervalMs:0,fetch:async()=>new Response('',{status:202})});cleanup.push(()=>r.close());return r;};
  const next=restart(),owner=next.grants.resolve(`Bearer ${token}`,'owner');next.pumpScheduledFixtures();
  const fired=next.schedules.read(owner,job.id);expect(fired).toMatchObject({status:'fired',runAt:job.runAt});
  await next.close();const again=restart();again.pumpScheduledFixtures();
  expect(again.schedules.read(again.grants.resolve(`Bearer ${token}`,'owner'),job.id).workId).toBe(fired.workId);
  for(const table of ['work','probes','notifications'])expect(again.store.one<{n:number}>(`SELECT COUNT(*) n FROM ${table}`)!.n).toBe(1);
});

it('rolls back partial probe/wakeup setup and recovers the existing source with its original deadline after restart',async()=>{
  const h=await setup(),token=h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN;
  const job=(await h.http('/test/schedules',token,{eventId:'partial_setup_restart'})).value.schedule;
  const prepare=h.runtime.schedules.hooks.prepareOnboarding;
  h.runtime.schedules.hooks.prepareOnboarding=(owner,id)=>{prepare(owner,id);throw new Error('Injected crash after setup writes');};
  h.clock.now+=300000;expect(()=>h.runtime.pumpScheduledFixtures()).toThrow('Injected crash');
  const before=h.runtime.store.one<{id:string;deadline:number}>('SELECT id,deadline FROM work')!;
  expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM probes')!.n).toBe(0);
  expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM notifications')!.n).toBe(0);
  await h.runtime.close();h.clock.now+=10000;
  const next=createHostedPhase05Test(h.config,{now:()=>h.clock.now,workerIntervalMs:0,fetch:async()=>new Response('',{status:202})});cleanup.push(()=>next.close());next.pumpScheduledFixtures();
  expect(next.store.one('SELECT id,deadline FROM work')).toMatchObject(before);
  expect(next.schedules.read(next.grants.resolve(`Bearer ${token}`,'owner'),job.id)).toMatchObject({status:'fired',workId:before.id});
  for(const table of ['work','probes','notifications'])expect(next.store.one<{n:number}>(`SELECT COUNT(*) n FROM ${table}`)!.n).toBe(1);
});

it('does not grant a fresh deadline or stale wakeup to partial work recovered after its original deadline',async()=>{
  const h=await setup(),token=h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN;
  const job=(await h.http('/test/schedules',token,{eventId:'partial_setup_expired'})).value.schedule;
  h.runtime.schedules.hooks.prepareOnboarding=()=>{throw new Error('Injected crash before setup');};
  h.clock.now+=300000;expect(()=>h.runtime.pumpScheduledFixtures()).toThrow();
  const original=h.runtime.store.one<{id:string;deadline:number}>('SELECT id,deadline FROM work')!;
  await h.runtime.close();h.clock.now+=120001;
  const next=createHostedPhase05Test(h.config,{now:()=>h.clock.now,workerIntervalMs:0,fetch:async()=>new Response('',{status:202})});cleanup.push(()=>next.close());next.pumpScheduledFixtures();await next.engine.tick();
  expect(next.schedules.read(next.grants.resolve(`Bearer ${token}`,'owner'),job.id)).toMatchObject({status:'expired',workId:original.id});
  expect(next.store.one<{deadline:number}>('SELECT deadline FROM work')!.deadline).toBe(original.deadline);
  expect(next.store.one<{n:number}>('SELECT COUNT(*) n FROM notifications')!.n).toBe(0);
  expect(next.store.one<{n:number}>('SELECT COUNT(*) n FROM simulated_provider_receipts')!.n).toBe(1);
});

it('expires a missed schedule without fabricating a later fixture',async()=>{
  const h=await setup(),token=h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN;
  const job=(await h.http('/test/schedules',token,{eventId:'missed_host_window'})).value.schedule;
  h.clock.now+=305001;h.runtime.pumpScheduledFixtures();
  expect((await h.http(`/test/schedules/${job.id}`,token)).value.schedule).toMatchObject({status:'expired',workId:null,error:'SCHEDULE_WINDOW_MISSED'});
  expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM work')!.n).toBe(0);
});

it('does not queue onboarding after a source-creation stall crosses the durable work deadline',async()=>{
  const h=await setup(),token=h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN;
  const job=(await h.http('/test/schedules',token,{eventId:'server_stall_after_source'})).value.schedule;
  const create=h.runtime.schedules.hooks.createFixture;
  h.runtime.schedules.hooks.createFixture=(owner,id)=>{const workId=create(owner,id);h.clock.now+=120001;return workId;};
  h.clock.now+=300000;h.runtime.pumpScheduledFixtures();await h.runtime.engine.tick();
  expect((await h.http(`/test/schedules/${job.id}`,token)).value.schedule).toMatchObject({status:'expired',error:'SCHEDULE_WINDOW_MISSED'});
  expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM notifications')!.n).toBe(0);
  expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM probes')!.n).toBe(0);
  expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM simulated_provider_receipts')!.n).toBe(1);
});

it('revalidates grants at fire time while allowing the other tenant to proceed',async()=>{
  const h=await setup();
  const a=(await h.http('/test/schedules',h.env.CLEANER_TEST_ADMIN_TOKEN,{eventId:'live_grant_at_fire'})).value.schedule;
  const b=(await h.http('/test/schedules',h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN,{eventId:'live_grant_at_fire'})).value.schedule;
  const owner=h.runtime.grants.resolve(`Bearer ${h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN}`,'owner'),agent=h.runtime.grants.resolve(`Bearer ${h.env.CLEANER_PHASE05_TENANT_B_AGENT_TOKEN}`,'agent');
  h.runtime.grants.revoke(owner,agent.grantId);h.clock.now+=300000;h.runtime.pumpScheduledFixtures();
  expect((await h.http(`/test/schedules/${b.id}`,h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN)).value.schedule).toMatchObject({status:'failed',error:'UNAUTHORIZED',workId:null});
  expect((await h.http(`/test/schedules/${a.id}`,h.env.CLEANER_TEST_ADMIN_TOKEN)).value.schedule.status).toBe('fired');
  expect(h.runtime.store.one<{n:number}>("SELECT COUNT(*) n FROM work WHERE tenant='B'")!.n).toBe(0);
});

it('requires the original owner authorization to remain valid when a queued fixture fires',async()=>{
  const h=await setup(),token=h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN;
  const job=(await h.http('/test/schedules',token,{eventId:'owner_authority_expired'})).value.schedule;
  const owner=h.runtime.grants.resolve(`Bearer ${token}`,'owner');
  h.runtime.store.run('UPDATE grants SET expires=? WHERE id=?',h.clock.now+1000,owner.grantId);
  h.clock.now+=300000;h.runtime.pumpScheduledFixtures();
  expect(h.runtime.store.one('SELECT status,error,work_id FROM test_fixture_schedules WHERE id=?',job.id)).toMatchObject({status:'failed',error:'UNAUTHORIZED',work_id:null});
  expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM work')!.n).toBe(0);
});

it('exposes an unexpected scheduler failure and rejects new jobs instead of reporting the scheduler healthy',async()=>{
  const callbacks:Array<()=>void>=[];
  const timers:FixtureTimers={set:callback=>{callbacks.push(callback);return {} as ReturnType<typeof setTimeout>;},clear:()=>{}};
  const h=await setup({fixtureTimers:timers});h.runtime.schedules.start();
  await h.http('/test/schedules',h.env.CLEANER_TEST_ADMIN_TOKEN,{eventId:'scheduler_failure'});
  h.runtime.schedules.hooks.prepareOnboarding=()=>{throw new Error('Injected unexpected scheduler error');};
  h.clock.now+=300000;callbacks.at(-1)!();
  expect((await h.http('/test/runtime',h.env.CLEANER_TEST_ADMIN_TOKEN)).value.fixtureSchedulerHealthy).toBe(false);
  expect((await h.http('/test/schedules',h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN,{eventId:'new_job_rejected'})).status).toBe(503);
  expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM notifications')!.n).toBe(0);
});

it('keeps stable schedule payloads, rejects reused sources, bounds tenant queues and permits owner cancellation',async()=>{
  const h=await setup(),a=h.env.CLEANER_TEST_ADMIN_TOKEN,b=h.env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN;
  const queued=(await h.http('/test/schedules',a,{eventId:'stable_schedule',delaySeconds:300})).value.schedule;
  h.clock.now+=1000;
  expect((await h.http('/test/schedules',a,{eventId:'stable_schedule',delaySeconds:300})).value.schedule.runAt).toBe(queued.runAt);
  expect((await h.http('/test/schedules',a,{eventId:'stable_schedule',delaySeconds:600})).status).toBe(409);
  expect((await h.http('/test/schedules',a,{eventId:'another_onboarding'})).status).toBe(429);
  expect((await h.http('/test/schedules',a,{eventId:'invalid_delay',delaySeconds:29})).status).toBe(400);
  expect((await h.http(`/test/schedules/${queued.id}`,a,undefined,'DELETE')).value.schedule.status).toBe('cancelled');
  await h.http('/test/events',a,{eventId:'already_created_source'});
  expect((await h.http('/test/schedules',a,{eventId:'already_created_source'})).status).toBe(409);
  for(let n=0;n<12;n++)expect((await h.http('/test/schedules',a,{eventId:`ordinary_${n}`,kind:'ordinary',delaySeconds:300})).status).toBe(202);
  expect((await h.http('/test/schedules',a,{eventId:'over_tenant_limit',kind:'ordinary'})).status).toBe(429);
  expect((await h.http('/test/schedules',b,{eventId:'other_tenant_proceeds',kind:'ordinary',delaySeconds:300})).status).toBe(202);
  h.clock.now+=300000;h.runtime.pumpScheduledFixtures();
  expect(h.runtime.store.one<{n:number}>("SELECT COUNT(*) n FROM test_fixture_schedules WHERE tenant='A' AND status='fired'")!.n).toBe(1);
  expect(h.runtime.store.one<{n:number}>("SELECT COUNT(*) n FROM test_fixture_schedules WHERE tenant='B' AND status='fired'")!.n).toBe(1);
  expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM notifications')!.n).toBe(0);
});
