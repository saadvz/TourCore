import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { CleanerStore } from './store';
import { CleanerGrants, type GrantIdentity } from './grants';
import { CleanerEngine, type ProviderBinding, type CleanerLimits } from './engine';
import { CleanerProfiles } from './profiles';
import { CleanerNotifications, type AgentWakeup } from './notifications';
import { delegationApp } from '../mcp';
import { DelegationError } from '../prototype';
import { AgentId } from '../../agents/profile';

export const ingressSignature=(secret:string,timestamp:string,body:Buffer|string)=>createHmac('sha256',secret).update(timestamp).update('.').update(body).digest('hex');
/** Explicit local composition only. Nothing in the existing installation starts this runtime. */
export function createCleanerPhase05(options:{root:string;owners:Array<{tenantId:string;token:string}>;bindings:ProviderBinding[];wakeups?:AgentWakeup[];now?:()=>number;limits?:Partial<CleanerLimits>;validityMs?:number;workerIntervalMs?:number;publicBaseUrl?:string;railwayHealthcheck?:boolean}) {
  if (!Number.isSafeInteger(options.workerIntervalMs??250) || (options.workerIntervalMs??250)<0) throw new Error('Worker interval must be nonnegative; zero is controlled-test mode.');
  const now=options.now??Date.now,store=new CleanerStore(join(options.root,'cleaner.sqlite')),grants=new CleanerGrants(store,now);
  try{for(const owner of options.owners)grants.bootstrap(owner.tenantId,owner.token);}catch(e){store.close();throw e;}
  const engine=new CleanerEngine(store,grants,options.bindings,now,options.limits),profiles=new CleanerProfiles(store,grants,now,options.validityMs),notifications=new CleanerNotifications(store,grants,profiles,engine,options.wakeups??[],now);
  const app=express();app.disable('x-powered-by');
  const allowedHosts=['127.0.0.1','localhost','[::1]'];
  if(options.publicBaseUrl){const u=new URL(options.publicBaseUrl);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Use a trusted HTTPS public origin');allowedHosts.push(u.hostname);}
  if(options.railwayHealthcheck)allowedHosts.push('healthcheck.railway.app');
  const fail=(res:express.Response,error:unknown)=>{
    const code=error instanceof DelegationError?error.code:error instanceof z.ZodError?'INVALID_INPUT':'UNAVAILABLE';
    res.status(code==='UNAUTHORIZED'?401:code==='NOT_FOUND'?404:code==='RATE_LIMIT'?429:code==='INVALID_INPUT'?400:code==='UNAVAILABLE'?503:409).json({error:code});
  };
  // Synthetic adapter protocol, deliberately separate from real Twilio/Sendblue endpoints.
  app.post('/providers/:binding/:operation',express.raw({type:'application/json',limit:'32kb'}),(req,res)=>{
    try{
      const binding=options.bindings.find(b=>b.id===req.params.binding),timestamp=req.get('X-Cleaner-Timestamp'),signature=req.get('X-Cleaner-Signature');
      if(!binding||!timestamp||!/^\d{13}$/.test(timestamp)||Math.abs(Number(timestamp)-now())>30000||!signature||!Buffer.isBuffer(req.body))throw new DelegationError('UNAUTHORIZED','Invalid provider proof.');
      const expected=Buffer.from(ingressSignature(binding.ingressSecret,timestamp,req.body),'hex'),supplied=Buffer.from(signature,'hex');
      if(!/^[a-f0-9]{64}$/.test(signature)||expected.length!==supplied.length||!timingSafeEqual(expected,supplied))throw new DelegationError('UNAUTHORIZED','Invalid signature.');
      const envelope=z.strictObject({account:z.string(),to:z.string(),from:z.string().optional(),payload:z.unknown()}).parse(JSON.parse(req.body.toString('utf8')));
      if(envelope.account!==binding.account||envelope.to!==binding.number)throw new DelegationError('UNAUTHORIZED','Account/number not owned by signer.');
      if(req.params.operation==='inbound'&&envelope.from!==binding.recipient)throw new DelegationError('UNAUTHORIZED','Inbound sender is not the bound cleaner.');
      if(!store.consume(binding.tenantId,'ingress',now(),engine.limits.requestsPerSecond))throw new DelegationError('RATE_LIMIT','Tenant ingress budget exhausted.');
      if(req.params.operation==='inbound')res.json({accepted:true,workId:engine.receive(binding,envelope.payload)});
      else if(req.params.operation==='status')res.json(engine.delivery(binding,envelope.payload));
      else throw new DelegationError('NOT_FOUND','No provider operation.');
    }catch(e){fail(res,e);}
  });
  app.use(express.json({limit:'32kb'}));
  const inFlight=new Map<string,number>();
  app.use((req,res,next)=>{
    if(!req.path.startsWith('/owner')&&!req.path.startsWith('/test')&&req.path!=='/mcp'&&req.path!=='/oauth/authorize'&&req.path!=='/oauth/revoke')return next();
    try{
      const identity=grants.resolve(req.headers.authorization,req.path==='/mcp'?'agent':'owner');
      if((inFlight.get(identity.tenantId)??0)>=8||!store.consume(identity.tenantId,'requests',now(),engine.limits.requestsPerSecond))throw new DelegationError('RATE_LIMIT','Tenant request budget exhausted.');
      inFlight.set(identity.tenantId,(inFlight.get(identity.tenantId)??0)+1);
      let released=false;const release=()=>{if(!released){released=true;inFlight.set(identity.tenantId,Math.max(0,(inFlight.get(identity.tenantId)??1)-1));}};
      res.once('finish',release);res.once('close',release);res.locals.identity=identity;res.setHeader('Cache-Control','no-store');next();
    }catch(e){fail(res,e);}
  });
  const route=(action:(i:GrantIdentity,req:express.Request)=>unknown|Promise<unknown>)=>async(req:express.Request,res:express.Response)=>{
    try{res.json(await action(grants.resolve(req.headers.authorization,'owner'),req));}catch(e){fail(res,e);}
  };
  app.post('/owner/agents',route((i,r)=>grants.agent(i,r.body)));
  app.post('/owner/grants',route((i,r)=>grants.grant(i,r.body)));
  app.delete('/owner/grants/:id',route((i,r)=>grants.revoke(i,r.params.id as string)));
  app.post('/owner/turns',route(async(i,r)=>{await engine.saveTurn(i,r.body);return {saved:true};}));
  app.get('/owner/work/:id',route((i,r)=>engine.evidence(i,r.params.id as string)));
  app.get('/owner/agents/:id/profile',route((i,r)=>{grants.validate(i,'owner');return profiles.readiness(i.tenantId,r.params.id as string,engine.limits.deadlineMs);}));
  app.post('/owner/agents/:id/verify-workflow',route((i,r)=>profiles.verifyWorkflow(i,{...z.record(z.string(),z.unknown()).parse(r.body),agentId:r.params.id},engine)));
  app.post('/owner/agents/:id/probes/core-mcp',route((i,r)=>{const p=z.strictObject({workId:AgentId}).parse(r.body);return profiles.beginCoreRead(i,r.params.id as string,p.workId);}));
  app.post('/owner/notifications',route((i,r)=>{const p=z.strictObject({workId:AgentId,agentId:AgentId}).parse(r.body);return notifications.onboarding(i,p.workId,p.agentId);}));
  app.get('/owner/notifications/:id/:agent',route((i,r)=>notifications.status(i,r.params.id as string,r.params.agent as string)));
  const Property=z.strictObject({id:AgentId,name:z.string().min(1).max(100)});
  app.post('/owner/properties',route((i,r)=>{const p=Property.parse(r.body);store.run('INSERT INTO properties VALUES(?,?,?) ON CONFLICT(tenant,id) DO UPDATE SET data=excluded.data',i.tenantId,p.id,JSON.stringify(p));return {saved:true};}));
  app.get('/owner/properties/:id',route((i,r)=>{const p=store.one<{data:string}>('SELECT data FROM properties WHERE tenant=? AND id=?',i.tenantId,r.params.id as string);if(!p)throw new DelegationError('NOT_FOUND','No owned property.');return JSON.parse(p.data);}));
  app.post('/owner/access',route((i,r)=>{
    const p=z.strictObject({id:AgentId,propertyId:AgentId,hostClearance:z.boolean(),expiresAt:z.iso.datetime()}).parse(r.body);
    if(!store.one('SELECT id FROM properties WHERE tenant=? AND id=?',i.tenantId,p.propertyId))throw new DelegationError('NOT_FOUND','No owned property.');
    store.run('INSERT INTO access_records VALUES(?,?,?,?) ON CONFLICT(tenant,id) DO UPDATE SET property=excluded.property,data=excluded.data',i.tenantId,p.id,p.propertyId,JSON.stringify(p));return {recorded:true,operatesDoors:false};
  }));
  app.get('/owner/access/:id',route((i,r)=>{
    const p=store.one<{data:string}>('SELECT data FROM access_records WHERE tenant=? AND id=?',i.tenantId,r.params.id as string);if(!p)throw new DelegationError('NOT_FOUND','No owned access record.');
    const data=JSON.parse(p.data);return {...data,clearanceCurrent:data.hostClearance&&Date.parse(data.expiresAt)>now(),operatesDoors:false};
  }));
  app.post('/owner/oauth/clients',route((i,r)=>grants.register(i,r.body)));
  app.post('/oauth/authorize',route((i,r)=>grants.authorize(i,r.body)));
  app.post('/oauth/token',express.urlencoded({extended:false}),(req,res)=>{try{res.setHeader('Cache-Control','no-store');res.json(grants.token(req.body));}catch(e){fail(res,e);}});
  app.post('/oauth/revoke',route((i,r)=>{const p=z.strictObject({grantId:z.string()}).parse(r.body);return grants.revoke(i,p.grantId);}));
  app.use(delegationApp(engine,[],{profiles,allowedHosts,resolve:header=>grants.resolve(header,'agent'),deadlineMs:engine.limits.deadlineMs}));
  let closing=false,failed=false;const pending=new Set<Promise<void>>();
  // Independent bounded lanes continue serving B while A is pending. No unbounded interval task queue.
  const pump=()=>{if(closing)return;for(const worker of [engine,notifications]){const task=worker.tick();pending.add(task);void task.finally(()=>pending.delete(task)).catch(()=>{failed=true;});}};
  app.get('/healthz',(_req,res)=>res.status(failed?503:200).json({service:'cleaner-phase05-local',runtimeVersion:'phase05-indexed-v1',tenantCount:options.owners.length,ready:!failed}));
  const timer=(options.workerIntervalMs??250)>0?setInterval(pump,options.workerIntervalMs??250):undefined;timer?.unref();
  return {app,store,grants,engine,profiles,notifications,pump,close:async()=>{closing=true;if(timer)clearInterval(timer);await Promise.allSettled(pending);await Promise.all([engine.drain(),notifications.drain()]);store.close();}};
}
