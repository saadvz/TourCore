import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from 'node:http';
import { createCleanerPhase05, ingressSignature } from '../src/delegation/phase05/service';
import { DefinitelyNotAccepted, type ProviderBinding, type CleanerLimits } from '../src/delegation/phase05/engine';
import type { AgentWakeup } from '../src/delegation/phase05/notifications';

const cleanup:Array<()=>unknown|Promise<unknown>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const epoch=Date.parse('2026-10-12T12:00:00Z');
const iso=(hours:number)=>new Date(epoch+hours*3600000).toISOString();
const token=()=>randomBytes(32).toString('hex');
const turn=(recipient:string,version=1)=>({id:'same_booking',version,recipient,timeZone:'America/New_York',windowStart:iso(24),windowEnd:iso(30),nextArrival:iso(31),minimumMinutes:90});
async function setup(options:{limits?:Partial<CleanerLimits>;validityMs?:number;send?:[ProviderBinding['send']?,ProviderBinding['send']?];guarantees?:['idempotent'|'non_idempotent','idempotent'|'non_idempotent'];notify?:[AgentWakeup['notify']?,AgentWakeup['notify']?];workerIntervalMs?:number}={}) {
  mkdirSync('work',{recursive:true});const root=mkdtempSync(join(process.cwd(),'work','cleaner-test-'));
  cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const clock={t:epoch};const owners=[{tenantId:'A',token:token()},{tenantId:'B',token:token()}];
  const delivered:Array<{key:string;tenantId:string;from:string;recipient:string;text:string}>=[],wakeups:Array<{tenant:string;event:unknown}>=[];
  const bindings:ProviderBinding[]=owners.map((o,index)=>({id:`provider_${o.tenantId}`,tenantId:o.tenantId,account:`account_${o.tenantId}`,number:`synthetic_number_${o.tenantId}`,recipient:`synthetic_cleaner_${o.tenantId}`,ingressSecret:token(),credentialEpoch:'1',guarantee:options.guarantees?.[index]??'idempotent',send:options.send?.[index]??(async r=>{if(!delivered.some(d=>d.key===r.key))delivered.push(r);return {receipt:`synthetic_receipt_${r.key}`};})}));
  const routes:AgentWakeup[]=owners.map((o,index)=>({tenantId:o.tenantId,agentId:'same_agent',notify:options.notify?.[index]??(async event=>{wakeups.push({tenant:o.tenantId,event});return 202;})}));
  const config={root,owners,bindings,wakeups:routes,workerIntervalMs:options.workerIntervalMs??0,now:()=>clock.t,limits:{requestsPerSecond:1000,...options.limits},validityMs:options.validityMs};
  let runtime=createCleanerPhase05(config),server:Server|undefined,base='';
  const listen=async()=>{server=await new Promise<Server>(resolve=>{const s=runtime.app.listen(0,'127.0.0.1',()=>resolve(s));});base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;};await listen();
  const closeServer=()=>new Promise<void>(resolve=>{if(!server)return resolve();server.closeAllConnections();server.close(()=>resolve());server=undefined;});
  cleanup.push(async()=>{await closeServer();await runtime.close();});
  const api=async(path:string,body?:unknown,index=0,method=body===undefined?'GET':'POST',credential=owners[index]!.token)=>{
    const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,value:await response.json() as any};
  };
  const ingress=async(index=0,payload:unknown={eventId:'same_source',turnId:'same_booking',requestedStart:iso(25)},operation='inbound',overrides:{path?:string;signer?:number;account?:string;number?:string;from?:string;timestamp?:string}={})=>{
    const b=bindings[index]!,raw=JSON.stringify({account:overrides.account??b.account,to:overrides.number??b.number,from:overrides.from??b.recipient,payload}),timestamp=overrides.timestamp??String(clock.t);
    const response=await fetch(base+(overrides.path??`/providers/${b.id}/${operation}`),{method:'POST',headers:{'Content-Type':'application/json','X-Cleaner-Timestamp':timestamp,'X-Cleaner-Signature':ingressSignature(bindings[overrides.signer??index]!.ingressSecret,timestamp,raw)},body:raw});
    return {status:response.status,value:await response.json() as any};
  };
  const oauth=async(index=0)=>{
    expect((await api('/owner/agents',{agentId:'same_agent'} ,index)).status).toBe(200);
    const redirect_uri='http://127.0.0.1/agent-callback';
    const client=(await api('/owner/oauth/clients',{agentId:'same_agent',redirect_uri},index)).value;
    const verifier=randomBytes(40).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
    const auth={client_id:client.client_id,redirect_uri,response_type:'code',code_challenge_method:'S256',code_challenge:challenge,state:'correlation'};
    const code=(await api('/oauth/authorize',auth,index)).value;
    const exchange={grant_type:'authorization_code',client_id:client.client_id,redirect_uri,code:code.code,code_verifier:verifier};
    const response=await api('/oauth/token',exchange,index);
    expect(response.status).toBe(200);
    return {...response.value,auth,exchange};
  };
  const connect=async(credential:string)=>{
    const client=new Client({name:'synthetic-grok-compatible-agent',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${credential}`}}}));
    cleanup.push(()=>client.close());
    const call=async(name:string,args:Record<string,unknown>={})=>{
      const result=await client.callTool({name,arguments:args});
      const content=result.content as Array<{type:string;text?:string}>;
      const raw=content.find(x=>x.type==='text')!.text!;
      let value:any;try{value=JSON.parse(raw);}catch{value={message:raw};}
      return {isError:result.isError,value};
    };
    return {client,call};
  };
  const seed=async(index=0,eventId='same_source')=>{
    expect((await api('/owner/turns',turn(bindings[index]!.recipient),index)).status).toBe(200);
    const response=await ingress(index,{eventId,turnId:'same_booking',requestedStart:iso(25)});expect(response.status).toBe(200);return response.value.workId as string;
  };
  const proposal=async(agent:Awaited<ReturnType<typeof connect>>,id:string,actionKey='same_action')=>{
    const claim=(await agent.call('claim_delegated_work',{id})).value;
    return {id,leaseToken:claim.leaseToken,expectedTurnVersion:claim.turn.version,start:iso(25),actionKey};
  };
  const restart=async()=>{await closeServer();await runtime.close();runtime=createCleanerPhase05(config);await listen();};
  return {get runtime(){return runtime;},get base(){return base;},root,clock,owners,bindings,delivered,wakeups,api,ingress,oauth,connect,seed,proposal,restart};
}

describe('Cleaner Phase 0.5 isolated shared runtime',()=>{
  it('isolates reciprocal MCP operations, owner data, provider ingress and indexed storage; commits two deterministic replies',async()=>{
    const h=await setup();const grants=[await h.oauth(0),await h.oauth(1)],agents=[await h.connect(grants[0].access_token),await h.connect(grants[1].access_token)];
    const ids=[await h.seed(0),await h.seed(1)];expect(ids[0]).not.toBe(ids[1]);
    for(let i=0;i<2;i++) {
      const own=agents[i]!,foreign=ids[1-i]!;
      expect((await own.client.listTools()).tools).toHaveLength(8);
      expect((await own.call('list_delegated_work')).value.map((w:any)=>w.id)).toEqual([ids[i]]);
      for(const tool of ['read_delegated_work','claim_delegated_work'])expect((await own.call(tool,{id:foreign})).value.code).toBe('NOT_FOUND');
      expect((await own.call('propose_cleaning_time',{id:foreign,leaseToken:'stolen',actionKey:'same_action',expectedTurnVersion:1,start:iso(25)})).value.code).toBe('NOT_FOUND');
      expect((await own.call('claim_delegated_work',{id:ids[i],tenantId:h.owners[1-i]!.tenantId})).isError).toBe(true);
      expect((await h.api(`/owner/work/${foreign}`,undefined,i)).status).toBe(404);
      expect((await h.api(`/owner/notifications/${foreign}/same_agent`,undefined,i)).status).toBe(404);
      expect((await h.api(`/owner/grants/${grants[1-i].grantId}`,undefined,i,'DELETE')).status).toBe(404);
      expect((await h.api('/owner/properties',{id:`property_${i}`,name:`Property ${i}`},i)).status).toBe(200);
      expect((await h.api('/owner/access',{id:`access_${i}`,propertyId:`property_${i}`,hostClearance:true,expiresAt:iso(1)},i)).status).toBe(200);
      expect((await h.api('/owner/access',{id:'foreign',propertyId:`property_${1-i}`,hostClearance:true,expiresAt:iso(1)},i)).status).toBe(404);
      expect((await h.api('/owner/turns',{...turn(h.bindings[1-i]!.recipient),version:2},i)).status).toBe(404);
      expect((await h.api('/owner/properties',{id:'bad',name:'bad',tenantId:h.owners[1-i]!.tenantId},i)).status).toBe(400);
      expect((await h.ingress(i,undefined,'inbound',{signer:1-i})).status).toBe(401);
      expect((await h.ingress(i,undefined,'inbound',{from:h.bindings[1-i]!.recipient})).status).toBe(401);
      expect((await h.ingress(i,undefined,'inbound',{account:h.bindings[1-i]!.account,number:h.bindings[1-i]!.number})).status).toBe(401);
      expect((await h.ingress(i,{eventId:'inject',turnId:'same_booking',requestedStart:iso(25),tenantId:h.owners[1-i]!.tenantId})).status).toBe(400);
      const action=await h.proposal(own,ids[i]!);
      expect((await own.call('propose_cleaning_time',action)).value).toMatchObject({accepted:true,completed:false,deliveryStatus:'pending'});
      expect((await own.call('read_delegated_work',{id:ids[i]})).value.turn).not.toHaveProperty('recipient');
    }
    for(let i=0;i<2;i++)for(const path of [`/owner/properties/property_${1-i}`,`/owner/access/access_${1-i}`])expect((await h.api(path,undefined,i)).status).toBe(404);
    expect(h.delivered).toHaveLength(0);await h.runtime.engine.tick();
    expect(h.delivered).toHaveLength(2);
    for(let i=0;i<2;i++) {
      expect(h.delivered.find(d=>d.tenantId===h.owners[i]!.tenantId)).toMatchObject({from:h.bindings[i]!.number,recipient:h.bindings[i]!.recipient});
      expect((await agents[i]!.call('read_delegated_work',{id:ids[i]})).value).toMatchObject({status:'completed',deliveryStatus:'sent'});
      const evidence=(await h.api(`/owner/work/${ids[i]}`,undefined,i)).value;
      expect(evidence.audit.some((a:any)=>a.type==='provider_accepted_and_completed')).toBe(true);
      expect(evidence.audit.some((a:any)=>a.type==='carrier_delivered')).toBe(false);
      const receipt=JSON.parse(evidence.reply).receipt;
      expect((await h.ingress(1-i,{workId:ids[i],receipt,status:'delivered'},'status')).status).toBe(404);
      expect((await h.ingress(i,{workId:ids[i],receipt,status:'delivered'},'status')).status).toBe(200);
    }
    const s=h.runtime.store;
    for(const table of ['work','outbox','actions','audit','properties','access_records','grants','bindings']) {
      expect(s.one<{n:number}>(`SELECT COUNT(*) n FROM ${table} WHERE tenant=?`,'A')!.n).toBeGreaterThan(0);
      expect(s.one<{n:number}>(`SELECT COUNT(*) n FROM ${table} WHERE tenant=?`,'B')!.n).toBeGreaterThan(0);
    }
    expect(()=>s.run("INSERT INTO work(tenant,id,binding,source,turn_id,status,deadline,data) VALUES('B','foreign','provider_B','bad','nonowned','pending',1,'{}')")).toThrow();
  });

  it('binds OAuth consent and PKCE to the owner/client, prevents replay, rotates refresh tokens and detects reuse',async()=>{
    const h=await setup();const a=await h.oauth(0),b=await h.oauth(1);
    expect((await h.api('/oauth/authorize',a.auth,1)).status).toBe(404);
    expect((await h.api('/oauth/authorize',b.auth,0)).status).toBe(404);
    expect((await h.api('/oauth/token',a.exchange)).status).toBe(401);
    const code=(await h.api('/oauth/authorize',a.auth)).value.code;
    expect((await h.api('/oauth/token',{...a.exchange,code,code_verifier:randomBytes(40).toString('base64url')})).status).toBe(401);
    expect((await h.api('/oauth/token',{...a.exchange,code,client_id:b.auth.client_id})).status).toBe(401);
    const c=(await h.api('/oauth/token',{...a.exchange,code})).value;
    const refresh={grant_type:'refresh_token',client_id:a.auth.client_id,refresh_token:c.refresh_token};
    const next=await h.api('/oauth/token',refresh);expect(next.status).toBe(200);
    expect(()=>h.runtime.grants.resolve(`Bearer ${c.access_token}`,'agent')).toThrow();
    expect((await h.api('/oauth/token',refresh)).status).toBe(401);
    expect(()=>h.runtime.grants.resolve(`Bearer ${next.value.access_token}`,'agent')).toThrow();
    expect(h.runtime.grants.resolve(`Bearer ${b.access_token}`,'agent').tenantId).toBe('B');
    expect((await h.api('/owner/grants',{agentId:'same_agent',tenantId:'B'})).status).toBe(400);
    expect((await h.api('/owner/properties',undefined,0,'GET',b.access_token)).status).toBe(401);
  });

  it('hot-revokes old MCP tokens, profile evidence and leases without restarting; leaves the other tenant eligible',async()=>{
    const h=await setup();const a=await h.oauth(0),b=await h.oauth(1),ca=await h.connect(a.access_token),cb=await h.connect(b.access_token),ids=[await h.seed(0),await h.seed(1)];
    for(const agent of [ca,cb]) {
      const probe=(await agent.call('begin_agent_probe',{capability:'mcp_tools'})).value;
      expect((await agent.call('complete_agent_probe',{probeId:probe.probeId,nonce:probe.nonce})).value.status).toBe('verified');
    }
    const action=await h.proposal(ca,ids[0]!);
    expect((await h.api(`/owner/grants/${a.grantId}`,undefined,0,'DELETE')).status).toBe(200);
    await expect(ca.call('read_delegated_work',{id:ids[0]})).rejects.toThrow();
    const renewed=(await h.api('/owner/grants',{agentId:'same_agent'})).value,newClient=await h.connect(renewed.access_token);
    expect((await newClient.call('read_agent_profile')).value.capabilities.find((c:any)=>c.capability==='mcp_tools').status).toBe('unknown');
    expect((await newClient.call('read_delegated_work',{id:ids[0]})).value.status).toBe('pending');
    expect((await newClient.call('propose_cleaning_time',action)).value.code).toBe('LEASE_INVALID');
    expect((await cb.call('read_agent_profile')).value.capabilities.find((c:any)=>c.capability==='mcp_tools').status).toBe('verified');
    expect((await cb.call('read_delegated_work',{id:ids[1]})).value.status).toBe('pending');
  });

  it('preserves source deduplication, absolute deadlines and fallback across a runtime restart',async()=>{
    const h=await setup();const id=await h.seed();const first=(await h.api(`/owner/work/${id}`)).value.work;
    expect((await h.ingress()).value.workId).toBe(id);
    expect((await h.ingress(0,{eventId:'same_source',turnId:'same_booking',requestedStart:iso(26)})).status).toBe(409);
    h.clock.t+=30000;await h.restart();
    expect((await h.ingress()).value.workId).toBe(id);
    expect((await h.api(`/owner/work/${id}`)).value.work.deadlineAt).toBe(first.deadlineAt);
    h.clock.t=Date.parse(first.deadlineAt);await h.runtime.engine.tick();
    expect(h.delivered).toHaveLength(1);expect(h.delivered[0]!.text).toContain('existing time is unchanged');
    expect((await h.api(`/owner/work/${id}`)).value.work).toMatchObject({status:'completed',decisionSource:'fallback'});
    await h.restart();await h.runtime.engine.tick();expect(h.delivered).toHaveLength(1);
  });

  it('compares leases and versions atomically; rejects stale leases/actions and conflicting stable action keys',async()=>{
    const h=await setup({limits:{leaseMs:1000}}),grant=await h.oauth(),agent=await h.connect(grant.access_token),id=await h.seed();
    const action=await h.proposal(agent,id);
    h.clock.t+=1000;const next=await h.proposal(agent,id);
    expect(next.leaseToken).not.toBe(action.leaseToken);
    expect((await agent.call('propose_cleaning_time',action)).value.code).toBe('LEASE_INVALID');
    await h.api('/owner/turns',turn(h.bindings[0]!.recipient,2));
    expect((await agent.call('propose_cleaning_time',next)).value.code).toBe('VERSION_CONFLICT');
    const valid={...next,expectedTurnVersion:2};
    const results=await Promise.all([agent.call('propose_cleaning_time',valid),agent.call('propose_cleaning_time',valid)]);
    expect(results.every(r=>r.value.accepted)).toBe(true);
    expect((await agent.call('propose_cleaning_time',{...valid,start:iso(26)})).value.code).toBe('ACTION_CONFLICT');
    h.clock.t+=120000;expect((await agent.call('propose_cleaning_time',valid)).value.accepted).toBe(true);
    await h.runtime.engine.tick();expect(h.delivered).toHaveLength(1);
    expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM actions')!.n).toBe(1);
  });

  it('refuses invalid scheduling slots and stale confirmations before the first provider attempt',async()=>{
    const h=await setup(),a=await h.oauth(),agent=await h.connect(a.access_token),id=await h.seed(),p=await h.proposal(agent,id);
    expect((await agent.call('propose_cleaning_time',{...p,start:iso(30)})).value.code).toBe('SLOT_INVALID');
    expect((await agent.call('propose_cleaning_time',p)).value.accepted).toBe(true);
    await h.api('/owner/turns',turn(h.bindings[0]!.recipient,3));await h.runtime.engine.tick();
    expect(h.delivered).toHaveLength(0);
    expect((await h.api(`/owner/work/${id}`)).value.work.status).toBe('review_required');
  });

  it('does not let slow tenant A hold a global section or prevent B from completing; bounds each tenant to one send',async()=>{
    let release:()=>void=()=>{};let calls=0;
    const h=await setup({send:[async()=>{calls++;await new Promise<void>(resolve=>{release=resolve;});return {receipt:'held_A'};}]});
    const ids=[await h.seed(0),await h.seed(1)];h.clock.t+=120000;
    const tick=h.runtime.engine.tick();
    await expect.poll(()=>calls).toBe(1);
    expect((await h.api(`/owner/work/${ids[1]}`,undefined,1)).value.work.status).toBe('completed');
    await h.runtime.engine.tick();expect(calls).toBe(1);
    expect(h.delivered.map(d=>d.tenantId)).toEqual(['B']);release();await tick;
    expect((await h.api(`/owner/work/${ids[0]}`)).value.work.status).toBe('completed');
  });

  it('round-robin admission with global concurrency one serves B before a second queued A reply',async()=>{
    const h=await setup({limits:{globalConcurrency:1,sendsPerSecond:10}});
    const a=await h.seed(0);const a2=(await h.ingress(0,{eventId:'second',turnId:'same_booking',requestedStart:iso(25)})).value.workId;const b=await h.seed(1);
    h.clock.t+=120000;await h.runtime.engine.tick();await h.runtime.engine.tick();
    expect(h.delivered.map(d=>d.tenantId)).toEqual(['A','B']);await h.runtime.engine.tick();
    expect(h.delivered.map(d=>d.key).sort()).toEqual([a,a2,b].map(id=>`reply_${id}`).sort());
  });

  it('applies durable separate request and provider rate budgets per tenant',async()=>{
    const h=await setup({limits:{requestsPerSecond:5,sendsPerSecond:1}});
    await h.seed(0);await h.seed(1);
    for(let i=0;i<5;i++)await h.api('/owner/properties',{id:`p${i}`,name:'x'});
    expect((await h.api('/owner/properties',{id:'limited',name:'x'})).status).toBe(429);
    expect((await h.api('/owner/properties',{id:'allowed',name:'x'},1)).status).toBe(200);
    for(let i=0;i<2;i++)await h.ingress(0,{eventId:`next_${i}`,turnId:'same_booking',requestedStart:iso(25)});
    h.clock.t+=120000;await h.runtime.engine.tick();await h.runtime.engine.tick();
    expect(h.delivered.filter(d=>d.tenantId==='A')).toHaveLength(1);
    expect(h.delivered.filter(d=>d.tenantId==='B')).toHaveLength(1);
    await h.restart();await h.runtime.engine.tick();expect(h.delivered.filter(d=>d.tenantId==='A')).toHaveLength(1);
    h.clock.t+=1000;await h.runtime.engine.tick();expect(h.delivered.filter(d=>d.tenantId==='A')).toHaveLength(2);
  });

  it('retries a lost acknowledgment with the same key only for an idempotent provider, across restart',async()=>{
    const seen=new Set<string>();let calls=0;
    const h=await setup({send:[async r=>{calls++;seen.add(r.key);if(calls===1)throw new Error('Lost ack');return {receipt:'durable_synthetic'};}]});
    const id=await h.seed();h.clock.t+=120000;await h.runtime.engine.tick();
    expect((await h.api(`/owner/work/${id}`)).value.work.status).toBe('reply_pending');
    await h.restart();await h.runtime.engine.tick();expect(calls).toBe(1);
    h.clock.t+=1000;await h.runtime.engine.tick();expect(calls).toBe(2);expect(seen.size).toBe(1);
    expect((await h.api(`/owner/work/${id}`)).value.work.status).toBe('completed');
  });

  it('mixed provider guarantees send uncertain non-idempotent A to review while retrying idempotent B',async()=>{
    const calls=[0,0];const h=await setup({guarantees:['non_idempotent','idempotent'],send:[async()=>{calls[0]!++;throw new Error('Unknown');},async()=>{calls[1]!++;throw new Error('Unknown');}]});
    const ids=[await h.seed(0),await h.seed(1)];h.clock.t+=120000;await h.runtime.engine.tick();await h.restart();h.clock.t+=1000;await h.runtime.engine.tick();
    expect(calls).toEqual([1,2]);expect((await h.api(`/owner/work/${ids[0]}`)).value.work.status).toBe('review_required');
    h.clock.t+=2000;await h.runtime.engine.tick();expect(calls).toEqual([1,3]);
    expect((await h.api(`/owner/work/${ids[1]}`,undefined,1)).value.work.status).toBe('review_required');
  });

  it('retries a provider-certified not-accepted outcome even without idempotency, but never retries mere rejection/uncertainty',async()=>{
    let calls=0;const h=await setup({guarantees:['non_idempotent','idempotent'],send:[async()=>{if(++calls===1)throw new DefinitelyNotAccepted('Adapter certifies no acceptance');return {receipt:'accepted'};}]});
    const id=await h.seed();h.clock.t+=120000;await h.runtime.engine.tick();h.clock.t+=1000;await h.runtime.engine.tick();
    expect(calls).toBe(2);expect((await h.api(`/owner/work/${id}`)).value.work.status).toBe('completed');
  });

  it('recovers an expired sending lease according to provider guarantees and ignores stale attempt completions',async()=>{
    const h=await setup({guarantees:['non_idempotent','idempotent']});const ids=[await h.seed(0),await h.seed(1)];h.clock.t+=120000;
    // Process died after persisting attempt, before response persistence. No real provider request.
    for(let i=0;i<2;i++){
      await h.api(`/owner/work/${ids[i]}`,undefined,i);const row=h.runtime.store.one<{data:string}>('SELECT data FROM outbox WHERE tenant=?',h.owners[i]!.tenantId)!;
      const reply=JSON.parse(row.data);reply.status='sending';reply.attempts=1;
      h.runtime.store.run('UPDATE outbox SET status=?,data=?,attempt_token=?,lease_until=? WHERE tenant=?','sending',JSON.stringify(reply),'old_attempt',h.clock.t+1000,h.owners[i]!.tenantId);
    }
    await h.restart();await h.runtime.engine.tick();expect(h.delivered).toHaveLength(0);
    h.clock.t+=1000;await h.runtime.engine.tick();expect(h.delivered.map(d=>d.tenantId)).toEqual(['B']);
    expect((await h.api(`/owner/work/${ids[0]}`)).value.work.status).toBe('review_required');
  });

  it('partitions notification retries and status; HTTP 202 remains pending work, not agent completion',async()=>{
    const calls=[0,0];const h=await setup({notify:[async()=>{calls[0]!++;return 503;},async()=>{calls[1]!++;return 202;}]});
    await h.oauth(0);await h.oauth(1);const ids=[await h.seed(0),await h.seed(1)];
    for(let i=0;i<2;i++)expect((await h.api('/owner/notifications',{workId:ids[i],agentId:'same_agent'},i)).status).toBe(200);
    await h.runtime.notifications.tick();expect(calls).toEqual([1,1]);
    expect((await h.api(`/owner/notifications/${ids[1]}/same_agent`,undefined,1)).value.status).toBe('accepted');
    expect((await h.api(`/owner/work/${ids[1]}`,undefined,1)).value.work.status).toBe('pending');
    await h.restart();h.clock.t+=1000;await h.runtime.notifications.tick();expect(calls).toEqual([2,1]);
    h.clock.t+=2000;await h.runtime.notifications.tick();expect(calls).toEqual([3,1]);
    expect((await h.api(`/owner/notifications/${ids[0]}/same_agent`)).value.status).toBe('failed');
    h.clock.t=epoch+120000;await h.runtime.engine.tick();expect(h.delivered).toHaveLength(2);
  });

  it('routes only fresh verified capability evidence, keeps probes tenant-scoped and invalidates queued dispatch on expiry',async()=>{
    const h=await setup({validityMs:10000}),a=await h.oauth(),b=await h.oauth(1),ca=await h.connect(a.access_token),cb=await h.connect(b.access_token),id=await h.seed();
    const probe=(await ca.call('begin_agent_probe',{capability:'mcp_tools'})).value;
    expect((await cb.call('complete_agent_probe',{probeId:probe.probeId,nonce:probe.nonce})).value.code).toBe('NOT_FOUND');
    await ca.call('complete_agent_probe',{probeId:probe.probeId,nonce:probe.nonce});
    await h.runtime.notifications.tick();expect(h.wakeups).toHaveLength(0);
    await h.api('/owner/notifications',{workId:id,agentId:'same_agent'});await h.runtime.notifications.tick();
    await ca.call('propose_cleaning_time',await h.proposal(ca,id));await h.runtime.engine.tick();
    const readiness=await h.api('/owner/agents/same_agent/verify-workflow',{workId:id,conversationClosed:true});expect(readiness.status).toBe(200);expect(readiness.value.readiness.executionMode).toBe('autonomous');
    h.runtime.notifications.routes[0]!.notify=async event=>{h.wakeups.push({tenant:'A',event});return 503;};
    const id2=(await h.ingress(0,{eventId:'fresh_dispatch',turnId:'same_booking',requestedStart:iso(26)})).value.workId;
    await h.runtime.notifications.tick();expect(h.wakeups).toHaveLength(2);
    expect((h.wakeups[1]!.event as any)).toEqual({schemaVersion:1,eventType:'cleaner.reschedule_requested',eventId:id2,workId:id2,deadlineAt:new Date(epoch+120000).toISOString()});
    h.clock.t+=10000;
    const id3=(await h.ingress(0,{eventId:'expired_dispatch',turnId:'same_booking',requestedStart:iso(26)})).value.workId;
    await h.runtime.notifications.tick();expect(h.wakeups).toHaveLength(2);
    expect((await h.api(`/owner/notifications/${id2}/same_agent`)).value.status).toBe('cancelled');
    expect((await ca.call('read_agent_profile')).value.readiness.executionMode).toBe('unavailable');
    h.clock.t=epoch+130000;await h.runtime.engine.tick();await h.runtime.engine.tick();
    expect((await h.api(`/owner/work/${id3}`)).value.work.decisionSource).toBe('fallback');
  });

  it('bounds provider timeout and suppresses overlapping sends from an adapter ignoring abort; B still completes',async()=>{
    let calls=0;const h=await setup({limits:{sendTimeoutMs:10},send:[async()=>{calls++;return new Promise(()=>{});}]});
    const ids=[await h.seed(0),await h.seed(1)];h.clock.t+=120000;await h.runtime.engine.tick();
    expect((await h.api(`/owner/work/${ids[1]}`,undefined,1)).value.work.status).toBe('completed');
    h.clock.t+=1000;await h.runtime.engine.tick();expect(calls).toBe(1);
  });

  it('rejects unsigned/expired ingress and expired OAuth codes/tokens; keeps access records deterministic',async()=>{
    const h=await setup(),a=await h.oauth(),id=await h.seed();
    expect((await h.ingress(0,undefined,'inbound',{timestamp:String(epoch-30001)})).status).toBe(401);
    const unsigned=await fetch(h.base+'/providers/provider_A/inbound',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});expect(unsigned.status).toBe(401);
    const code=(await h.api('/oauth/authorize',a.auth)).value.code;h.clock.t+=60000;
    expect((await h.api('/oauth/token',{...a.exchange,code})).status).toBe(401);
    await h.api('/owner/properties',{id:'home',name:'Synthetic home'});await h.api('/owner/access',{id:'record',propertyId:'home',hostClearance:true,expiresAt:new Date(h.clock.t+1000).toISOString()});
    expect((await h.api('/owner/access/record')).value.clearanceCurrent).toBe(true);h.clock.t+=1000;
    expect((await h.api('/owner/access/record')).value).toMatchObject({clearanceCurrent:false,operatesDoors:false});
    h.clock.t=epoch+3600000;expect(()=>h.runtime.grants.resolve(`Bearer ${a.access_token}`)).toThrow();
    expect((await h.api(`/owner/work/${id}`,undefined,0,'GET',a.access_token)).status).toBe(401);
  });
  it('enforces durable receipt order on the same turn and action-key uniqueness across work items',async()=>{
    const h=await setup(),a=await h.oauth(),agent=await h.connect(a.access_token),first=await h.seed();
    const second=(await h.ingress(0,{eventId:'ordered_second',turnId:'same_booking',requestedStart:iso(26)})).value.workId;
    expect((await agent.call('claim_delegated_work',{id:second})).value.code).toBe('ENTITY_BUSY');
    const p=await h.proposal(agent,first);await agent.call('propose_cleaning_time',p);
    expect((await agent.call('claim_delegated_work',{id:second})).value.code).toBe('ENTITY_BUSY');
    await h.runtime.engine.tick();const secondAction=await h.proposal(agent,second);
    expect((await agent.call('propose_cleaning_time',secondAction)).value.code).toBe('ACTION_CONFLICT');
    expect((await agent.call('propose_cleaning_time',{...secondAction,actionKey:'second_action'})).value.accepted).toBe(true);
    expect(()=>h.runtime.store.run("UPDATE work SET binding='provider_B' WHERE tenant='A'")).toThrow();
    expect(()=>h.runtime.store.run("UPDATE outbox SET binding='provider_B' WHERE tenant='A'")).toThrow();
  });

  it('rejects a stale worker completion by attempt token after ownership changes',async()=>{
    let release:(receipt:{receipt:string})=>void=()=>{};
    const h=await setup({send:[()=>new Promise(resolve=>{release=resolve;})]});
    const id=await h.seed();h.clock.t+=120000;
    const pending=h.runtime.engine.tick();
    await expect.poll(()=>h.runtime.store.one<{status:string}>('SELECT status FROM outbox')?.status).toBe('sending');
    h.runtime.store.run("UPDATE outbox SET attempt_token='new_owner',status='review_required' WHERE tenant='A'");
    h.runtime.store.run("UPDATE work SET status='review_required',data=json_set(data,'$.status','review_required') WHERE tenant='A'");
    release({receipt:'stale_receipt'});await pending;
    expect(h.runtime.store.one<{status:string;attempt_token:string}>('SELECT status,attempt_token FROM outbox')).toMatchObject({status:'review_required',attempt_token:'new_owner'});
    expect((await h.api(`/owner/work/${id}`)).value.work.status).toBe('review_required');
    expect((await h.api(`/owner/work/${id}`)).value.audit.some((x:any)=>x.type==='provider_accepted_and_completed')).toBe(false);
  });

  it.each(['idempotent','non_idempotent'] as const)('survives SIGKILL during an in-flight %s provider attempt',async guarantee=>{
    const h=await setup({guarantees:[guarantee,'idempotent'],limits:{sendTimeoutMs:1000}});
    const id=await h.seed();h.clock.t+=120000;
    const source=pathToFileURL(join(process.cwd(),'src/delegation/phase05/service.ts')).href;
    const childPath=join(h.root,'crash-child.mts');
    const config={root:h.root,owners:h.owners,bindings:h.bindings.map(({send:_send,...rest})=>rest)};
    writeFileSync(childPath,`import {createCleanerPhase05} from ${JSON.stringify(source)};
const config=${JSON.stringify(config)};
const runtime=createCleanerPhase05({...config,now:()=>${h.clock.t},limits:{sendTimeoutMs:1000},workerIntervalMs:0,bindings:config.bindings.map(b=>({...b,send:async()=>{process.send?.({sending:true});return new Promise(()=>{});}}))});
await runtime.engine.tick();
`);
    const child=spawn(process.execPath,['--import','tsx',childPath],{stdio:['ignore','ignore','pipe','ipc']});
    let diagnostic='';child.stderr?.on('data',chunk=>diagnostic+=chunk.toString());
    const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(new Error(diagnostic||'Child exited before provider attempt')));});
    expect(h.runtime.store.one<{status:string}>('SELECT status FROM outbox')!.status).toBe('sending');
    child.kill('SIGKILL');expect((await exited).signal).toBe('SIGKILL');
    await h.restart();await h.runtime.engine.tick();expect(h.delivered).toHaveLength(0);
    h.clock.t+=2000;await h.runtime.engine.tick();
    expect((await h.api(`/owner/work/${id}`)).value.work.status).toBe(guarantee==='idempotent'?'completed':'review_required');
    expect(h.delivered).toHaveLength(guarantee==='idempotent'?1:0);
  });

  it('runs fallback independently when the agent is closed, without a caller pumping the engine',async()=>{
    const h=await setup({workerIntervalMs:10}),id=await h.seed();h.clock.t+=120000;
    await expect.poll(()=>h.delivered.length).toBe(1);
    expect((await h.api(`/owner/work/${id}`)).value.work).toMatchObject({status:'completed',decisionSource:'fallback'});
    expect((await h.api('/healthz')).value.ready).toBe(true);
  });

  it('denies injected authority through every MCP tool and reciprocal probes and owner OAuth revocation',async()=>{
    const h=await setup(),grants=[await h.oauth(0),await h.oauth(1)],agents=[await h.connect(grants[0].access_token),await h.connect(grants[1].access_token)],ids=[await h.seed(0),await h.seed(1)];
    const probes=[];for(const agent of agents)probes.push((await agent.call('begin_agent_probe',{capability:'mcp_tools'})).value);
    for(let i=0;i<2;i++){
      const foreign=probes[1-i],agent=agents[i]!,extra={tenantId:h.owners[1-i]!.tenantId,agentId:'same_agent'};
      const args:Record<string,Record<string,unknown>>={list_delegated_work:{},read_delegated_work:{id:ids[i]},claim_delegated_work:{id:ids[i]},propose_cleaning_time:{id:ids[i],leaseToken:'fake',actionKey:'fake',expectedTurnVersion:1,start:iso(25)},read_agent_profile:{},declare_agent_capabilities:{capabilities:[]},begin_agent_probe:{capability:'mcp_tools'},complete_agent_probe:{probeId:probes[i].probeId,nonce:probes[i].nonce}};
      for(const [name,input] of Object.entries(args))expect((await agent.call(name,{...input,...extra})).isError).toBe(true);
      expect((await agent.call('complete_agent_probe',{probeId:foreign.probeId,nonce:foreign.nonce})).value.code).toBe('NOT_FOUND');
      expect((await h.api('/oauth/revoke',{grantId:grants[1-i].grantId},i)).status).toBe(404);
      expect((await h.api('/owner/agents/same_agent/verify-workflow',{workId:ids[1-i],conversationClosed:true},i)).status).toBe(404);
      expect((await h.api('/owner/notifications',{workId:ids[1-i],agentId:'same_agent'},i)).status).toBe(404);
      expect((await h.api('/owner/agents',{agentId:'hijack',tenantId:h.owners[1-i]!.tenantId},i)).status).toBe(400);
      expect((await h.api('/owner/properties',{id:'shared_property',name:h.owners[i]!.tenantId},i)).status).toBe(200);
      expect((await h.api('/owner/access',{id:'shared_access',propertyId:'shared_property',hostClearance:!!i,expiresAt:iso(1)},i)).status).toBe(200);
      expect((await h.api('/owner/properties/shared_property',undefined,i)).value.name).toBe(h.owners[i]!.tenantId);
      expect((await h.api('/owner/access/shared_access',undefined,i)).value.hostClearance).toBe(!!i);
    }
  });

  it('deduplicates scoped carrier callbacks without reopening actions or authorizing resend after delivery failure',async()=>{
    const h=await setup(),id=await h.seed();h.clock.t+=120000;await h.runtime.engine.tick();
    const receipt=JSON.parse((await h.api(`/owner/work/${id}`)).value.reply).receipt;
    const payload={workId:id,receipt,status:'failed',eventId:'carrier_event'};
    expect((await h.ingress(0,payload,'status')).status).toBe(200);
    expect((await h.ingress(0,payload,'status')).status).toBe(200);
    expect((await h.ingress(0,{...payload,status:'delivered'},'status')).status).toBe(409);
    expect((await h.ingress(1,payload,'status')).status).toBe(404);
    const evidence=(await h.api(`/owner/work/${id}`)).value;
    expect(evidence.carrierEvents).toHaveLength(1);expect(evidence.carrierEvents[0].status).toBe('failed');
    expect(evidence.work.status).toBe('completed');await h.runtime.engine.tick();expect(h.delivered).toHaveLength(1);
  });

  it('rolls back turn, action and audit together when outbox insertion fails, then accepts the identical retry',async()=>{
    const h=await setup(),g=await h.oauth(),agent=await h.connect(g.access_token),id=await h.seed(),action=await h.proposal(agent,id);
    h.runtime.store.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected disk failure'); END");
    expect((await agent.call('propose_cleaning_time',action)).value.code).toBe('UNAVAILABLE');
    expect((await agent.call('read_delegated_work',{id})).value).toMatchObject({status:'leased',turn:{version:1}});
    expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM actions')!.n).toBe(0);
    expect(h.runtime.store.one<{n:number}>('SELECT COUNT(*) n FROM outbox')!.n).toBe(0);
    expect((await h.api(`/owner/work/${id}`)).value.audit.some((a:any)=>a.type==='validated_action_and_reply_saved')).toBe(false);
    h.runtime.store.db.exec('DROP TRIGGER fail_outbox');
    expect((await agent.call('propose_cleaning_time',action)).value.accepted).toBe(true);await h.runtime.engine.tick();expect(h.delivered).toHaveLength(1);
  });

  it('limits concurrent authenticated HTTP operations per tenant while another tenant can read',async()=>{
    const h=await setup(),ga=await h.oauth(),gb=await h.oauth(1),a=await h.connect(ga.access_token),b=await h.connect(gb.access_token),ids=[await h.seed(0),await h.seed(1)];
    const original=h.runtime.engine.get.bind(h.runtime.engine);let release:()=>void=()=>{};
    const held=new Promise<void>(resolve=>{release=resolve;});
    h.runtime.engine.get=async(identity,id)=>{if(identity.tenantId==='A')await held;return original(identity,id);};
    let denied=0;
    const calls=Array.from({length:9},()=>a.call('read_delegated_work',{id:ids[0]}).catch(error=>{denied++;throw error;}));
    const settled=Promise.allSettled(calls);
    await expect.poll(()=>denied).toBe(1);
    expect((await b.call('read_delegated_work',{id:ids[1]})).value.id).toBe(ids[1]);
    release();const results=await settled;expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(8);
  });

  it('keeps per-provider source IDs separate within a tenant and rejects provider rebinding on restart',async()=>{
    const h=await setup(),id=await h.seed();
    h.bindings.push({...h.bindings[0]!,id:'provider_A_second',account:'second_account_A',number:'second_number_A'});
    await h.restart();const next=(await h.ingress(2)).value.workId;expect(next).not.toBe(id);
    expect(h.runtime.store.one<{n:number}>("SELECT COUNT(*) n FROM work WHERE tenant='A' AND source='same_source'")!.n).toBe(2);
    // Check constructor refusal using the same indexed records; no credential or account is silently rebound.
    const bad={...h.bindings[0]!,tenantId:'B'};
    const {CleanerEngine}=await import('../src/delegation/phase05/engine');
    expect(()=>new CleanerEngine(h.runtime.store,h.runtime.grants,[bad],()=>h.clock.t)).toThrow('Provider rebinding');
  });

});
