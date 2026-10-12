import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { createCleanerPhase05 } from './service';
import type { ProviderBinding } from './engine';
import { DelegationError, TurnSchema } from '../prototype';
import { resolveTestStartupConfig, validateTestCredentials, DelegationStartupError } from '../startupConfig';
import type { CleanerStore } from './store';

export function phase05TestConfig(env:NodeJS.ProcessEnv) {
  // Existing real-provider variables are preserved but never activated in this test runtime.
  const config=resolveTestStartupConfig({...env,CLEANER_TEST_SMS_ENABLED:'false'});
  const a=validateTestCredentials(env.CLEANER_TEST_AGENT_TOKEN,env.CLEANER_TEST_ADMIN_TOKEN);
  const b=validateTestCredentials(env.CLEANER_PHASE05_TENANT_B_AGENT_TOKEN,env.CLEANER_PHASE05_TENANT_B_ADMIN_TOKEN);
  if(new Set([a.agentToken,a.adminToken,b.agentToken,b.adminToken]).size!==4)throw new DelegationStartupError('Four distinct tenant test credentials are required.');
  return {...config,credentials:a,tenantB:b};
}
/** Same URL/volume, separate indexed test database. No SMS/access adapter is constructed. */
export function createHostedPhase05Test(config:ReturnType<typeof phase05TestConfig>,options:{now?:()=>number;workerIntervalMs?:number;fetch?:typeof fetch;railwayHealthcheck?:boolean}={}) {
  const now=options.now??Date.now,agentId='grok_test_agent';
  const owners=[{tenantId:'A',token:config.credentials.adminToken},{tenantId:'B',token:config.tenantB.adminToken}];let store:CleanerStore;
  const bindings:ProviderBinding[]=owners.map(o=>({id:`provider_${o.tenantId}`,tenantId:o.tenantId,account:`synthetic_account_${o.tenantId}`,number:`synthetic_line_${o.tenantId}`,recipient:`synthetic_cleaner_${o.tenantId}`,credentialEpoch:'1',ingressSecret:createHash('sha256').update(`synthetic ingress:${o.token}`).digest('hex'),guarantee:'idempotent',send:async reply=>store.tx(()=>{
    if(reply.tenantId!==o.tenantId||reply.recipient!==`synthetic_cleaner_${o.tenantId}`||reply.from!==`synthetic_line_${o.tenantId}`)throw new Error('Synthetic provider recipient mismatch');
    const old=store.one<{text:string;recipient:string;receipt:string}>('SELECT text,recipient,receipt FROM simulated_provider_receipts WHERE tenant=? AND key=?',o.tenantId,reply.key);
    if(old){if(old.text!==reply.text||old.recipient!==reply.recipient)throw new Error('Synthetic idempotency conflict');return {receipt:old.receipt};}
    const receipt=`simulated_${randomUUID()}`;store.run('INSERT INTO simulated_provider_receipts VALUES(?,?,?,?,?,?)',o.tenantId,reply.key,reply.from,reply.recipient,reply.text,receipt);return {receipt};
  })}));
  const runtime=createCleanerPhase05({root:join(config.root,'phase05'),owners,bindings,now,workerIntervalMs:options.workerIntervalMs,publicBaseUrl:config.publicBaseUrl,railwayHealthcheck:options.railwayHealthcheck,wakeups:config.webhook?owners.map(o=>({tenantId:o.tenantId,agentId,notify:async(event,signal)=>{
    const response=await(options.fetch??fetch)(config.webhook!.url,{method:'POST',redirect:'error',signal,headers:{Authorization:config.webhook!.authorization,'Content-Type':'application/json'},body:JSON.stringify(event)});void response.body?.cancel().catch(()=>{});return response.status;
  }})):[]});
  store=runtime.store;
  store.db.exec('CREATE TABLE IF NOT EXISTS simulated_provider_receipts(tenant TEXT NOT NULL REFERENCES tenants(id),key TEXT NOT NULL,from_number TEXT NOT NULL,recipient TEXT NOT NULL,text TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(tenant,key))');
  runtime.grants.bootstrapAgent('A',agentId,config.credentials.agentToken);runtime.grants.bootstrapAgent('B',agentId,config.tenantB.agentToken);
  const app=runtime.app;
  // These compatibility routes remain owner-authenticated by the common /test middleware.
  app.post('/test/events',async(req,res)=>{
    try{
      const owner=runtime.grants.resolve(req.headers.authorization,'owner'),p=z.strictObject({eventId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)}).parse(req.body),binding=bindings.find(b=>b.tenantId===owner.tenantId)!;
      const source=`test_${p.eventId}`,previous=store.one<{id:string}>('SELECT id FROM work WHERE tenant=? AND binding=? AND source=?',owner.tenantId,binding.id,source);
      let id=previous?.id;
      if(!id){
        const turnId=`turn_${createHash('sha256').update(JSON.stringify([p.eventId])).digest('hex').slice(0,32)}`;
        const existing=store.one<{data:string}>('SELECT data FROM turns WHERE tenant=? AND id=?',owner.tenantId,turnId);
        const iso=(hours:number)=>new Date(now()+hours*3600000).toISOString();
        const turn=existing?TurnSchema.parse(JSON.parse(existing.data)):TurnSchema.parse({tenantId:owner.tenantId,id:turnId,version:1,recipient:binding.recipient,timeZone:'America/New_York',windowStart:iso(24),windowEnd:iso(30),nextArrival:iso(31),minimumMinutes:90});
        if(!existing)store.run('INSERT INTO turns VALUES(?,?,?,?)',owner.tenantId,turnId,1,JSON.stringify(turn));
        id=runtime.engine.receive(binding,{eventId:source,turnId,requestedStart:new Date(Date.parse(turn.windowStart)+3600000).toISOString()});
      }
      res.json({mode:'synthetic',work:await runtime.engine.get(owner,id)});
    }catch(error){res.status(error instanceof z.ZodError?400:error instanceof DelegationError&&error.code==='UNAUTHORIZED'?401:503).json({error:'Synthetic test request could not be confirmed; retry only the same eventId.'});}
  });
  app.get('/test/evidence/:id',async(req,res)=>{
    try{
      const owner=runtime.grants.resolve(req.headers.authorization,'owner'),id=req.params.id as string,evidence=await runtime.engine.evidence(owner,id);
      res.json({mode:'synthetic',...evidence,replies:store.all('SELECT key,recipient,text,receipt FROM simulated_provider_receipts WHERE tenant=? AND key=?',owner.tenantId,`reply_${id}`),notification:runtime.notifications.status(owner,id,agentId),carrierDelivery:'not applicable; simulated provider',operatesDoors:false});
    }catch(error){res.status(error instanceof DelegationError&&error.code==='NOT_FOUND'?404:error instanceof DelegationError&&error.code==='UNAUTHORIZED'?401:503).json({error:'No available owned test evidence.'});}
  });
  app.get('/test/runtime',(_req,res)=>res.json({service:'cleaner-core-phase05-test',mode:'synthetic',tenants:2,agentId,mcp:'/mcp',realSmsEnabled:false,version:'phase05-indexed-v1'}));
  return {...runtime,stop:runtime.close};
}
