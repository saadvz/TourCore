import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHostedPhase05Test, phase05TestConfig } from '../src/delegation/phase05/hostedTest';
const cleanup:Array<()=>unknown|Promise<unknown>>=[];afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
const credential=()=>randomBytes(32).toString('hex');
async function setup() {
  mkdirSync('work',{recursive:true});const root=mkdtempSync(join(process.cwd(),'work','hosted-phase05-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const env={CLEANER_TEST_HOME:root,CLEANER_TEST_PUBLIC_URL:'https://cleaner-test.example',CLEANER_TEST_HOST:'0.0.0.0',CLEANER_TEST_AGENT_TOKEN:credential(),CLEANER_TEST_ADMIN_TOKEN:credential(),CLEANER_PHASE05_TENANT_B_AGENT_TOKEN:credential(),CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN:credential(),CLEANER_TEST_SMS_ENABLED:'true',CLEANER_TEST_TWILIO_ACCOUNT_SID:'real-settings-must-not-be-used',CLEANER_TEST_TWILIO_AUTH_TOKEN:'not-to-be-used',CLEANER_TEST_TWILIO_FROM_NUMBER:'not-to-be-used',CLEANER_TEST_SMS_TEST_NUMBER:'not-to-be-used',CLEANER_TEST_WEBHOOK_URL:'https://injected.example/receiver',CLEANER_TEST_WEBHOOK_AUTH:'Bearer synthetic-test-receiver'};
  const clock={now:Date.parse('2026-10-12T12:00:00Z')};const config=phase05TestConfig(env);
  const runtime=createHostedPhase05Test(config,{now:()=>clock.now,workerIntervalMs:0,fetch:async()=>new Response('',{status:202}),railwayHealthcheck:true});cleanup.push(()=>runtime.close());
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
