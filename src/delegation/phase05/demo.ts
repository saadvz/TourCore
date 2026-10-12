import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCleanerPhase05, ingressSignature } from './service';
import type { ProviderBinding } from './engine';
import type { Server } from 'node:http';

/** Runnable two-tenant HTTP/OAuth/MCP demonstration, always fictional and local. */
mkdirSync('work',{recursive:true});const root=mkdtempSync(join(process.cwd(),'work','cleaner-demo-'));
const random=()=>randomBytes(32).toString('hex'),owners=['A','B'].map(tenantId=>({tenantId,token:random()}));
const receipts=new Map<string,string>(),observed:Array<{tenant:string;recipient:string;from:string}>=[];
const bindings:ProviderBinding[]=owners.map(o=>({id:`provider_${o.tenantId}`,tenantId:o.tenantId,account:`synthetic_account_${o.tenantId}`,number:`synthetic_number_${o.tenantId}`,recipient:`synthetic_cleaner_${o.tenantId}`,ingressSecret:random(),credentialEpoch:'1',guarantee:'idempotent',send:async r=>{
  let receipt=receipts.get(r.key);if(!receipt){receipt=`synthetic_${r.key}`;receipts.set(r.key,receipt);observed.push({tenant:r.tenantId,recipient:r.recipient,from:r.from});}return {receipt};
}}));
const runtime=createCleanerPhase05({root,owners,bindings,workerIntervalMs:0});const clients:Client[]=[];
let server:Server|undefined;
try {
  server=await new Promise<Server>(resolve=>{const s=runtime.app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,now=Date.now(),iso=(hours:number)=>new Date(now+hours*3600000).toISOString();
  const http=async(index:number,path:string,body?:unknown)=>{
    const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${owners[index]!.token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal(response.status,200);return await response.json() as Record<string,any>;
  };
  const workIds:string[]=[];const grants:Array<Record<string,any>>=[];
  for(let i=0;i<2;i++) {
    const b=bindings[i]!;await http(i,'/owner/agents',{agentId:'same_agent'});
    const redirect_uri='http://127.0.0.1/demo-callback',client=await http(i,'/owner/oauth/clients',{agentId:'same_agent',redirect_uri}),verifier=randomBytes(40).toString('base64url');
    const auth=await http(i,'/oauth/authorize',{client_id:client.client_id,redirect_uri,response_type:'code',code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),state:'demo'});
    const grant=await http(i,'/oauth/token',{grant_type:'authorization_code',client_id:client.client_id,redirect_uri,code:auth.code,code_verifier:verifier});grants.push(grant);
    await http(i,'/owner/turns',{id:'same_booking',version:1,recipient:b.recipient,timeZone:'America/New_York',windowStart:iso(24),windowEnd:iso(30),nextArrival:iso(31),minimumMinutes:90});
    const raw=JSON.stringify({account:b.account,to:b.number,from:b.recipient,payload:{eventId:'same_source',turnId:'same_booking',requestedStart:iso(25)}}),timestamp=String(Date.now());
    const inbound=await fetch(base+`/providers/${b.id}/inbound`,{method:'POST',headers:{'Content-Type':'application/json','X-Cleaner-Timestamp':timestamp,'X-Cleaner-Signature':ingressSignature(b.ingressSecret,timestamp,raw)},body:raw});assert.equal(inbound.status,200);workIds.push(((await inbound.json()) as {workId:string}).workId);
    const sdk=new Client({name:'synthetic-grok-compatible-agent',version:'1'});await sdk.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${grant.access_token}`}}}));clients.push(sdk);
  }
  const call=async(index:number,name:string,args:Record<string,unknown>={})=>{const response=await clients[index]!.callTool({name,arguments:args});return JSON.parse((response.content as Array<{text:string}>)[0]!.text);};
  for(let i=0;i<2;i++) {
    assert.equal((await call(i,'read_delegated_work',{id:workIds[1-i]})).code,'NOT_FOUND');
    const claimed=await call(i,'claim_delegated_work',{id:workIds[i]});
    const proposed=await call(i,'propose_cleaning_time',{id:workIds[i],leaseToken:claimed.leaseToken,actionKey:'same_action',expectedTurnVersion:claimed.turn.version,start:claimed.requestedStart});
    assert.equal(proposed.accepted,true);assert.equal(proposed.completed,false);
  }
  await runtime.engine.tick();
  for(let i=0;i<2;i++)assert.equal((await call(i,'read_delegated_work',{id:workIds[i]})).status,'completed');
  assert.equal(receipts.size,2);
  console.log(JSON.stringify({status:'pass',runtimeCount:1,tenants:2,transport:'loopback HTTP + SDK MCP',oauth:'owner-scoped PKCE authorization-code exchange',reciprocalForeignReads:'denied',reusedSourceBookingAgentActionIds:'isolated',providerReceipts:2,observed,phoneDelivery:'not tested; providers are injected simulations',realSms:0,doorOperations:0},null,2));
} finally {
  await Promise.all(clients.map(c=>c.close()));
  if(server)await new Promise<void>(resolve=>{server!.closeAllConnections();server!.close(()=>resolve());});
  await runtime.close();rmSync(root,{recursive:true,force:true});
}
