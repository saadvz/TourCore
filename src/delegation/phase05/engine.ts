import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentId } from '../../agents/profile';
import { DelegationError, TurnSchema, WorkSchema, type Work, type PrototypeTurn, type AgentIdentity } from '../prototype';
import { CleanerStore } from './store';
import { CleanerGrants, type GrantIdentity } from './grants';

export interface ProviderBinding {
  id:string; tenantId:string; account:string; number:string; recipient:string;
  /** Synthetic HMAC ingress credential. Real adapters must implement their own signature verification. */
  ingressSecret:string; credentialEpoch:string;
  guarantee:'idempotent' | 'non_idempotent';
  send(input:{key:string;tenantId:string;from:string;recipient:string;text:string;signal:AbortSignal}):Promise<{receipt:string}>;
}
export class DefinitelyNotAccepted extends Error {}
export interface CleanerLimits {deadlineMs:number;leaseMs:number;retryMs:number;maxAttempts:number;sendTimeoutMs:number;globalConcurrency:number;sendsPerSecond:number;requestsPerSecond:number}
const defaults:CleanerLimits = {deadlineMs:120000,leaseMs:60000,retryMs:1000,maxAttempts:3,sendTimeoutMs:5000,globalConcurrency:4,sendsPerSecond:2,requestsPerSecond:50};
type WorkRow = {data:string;binding:string};
type OutboxRow = {tenant:string;work_id:string;binding:string;status:string;due:number;attempt_token:string|null;lease_until:number|null;data:string};
export class CleanerEngine {
  readonly limits:CleanerLimits;
  private active = new Map<string,Promise<void>>();
  private transports = new Set<string>();
  private cursor = 0;
  constructor(readonly store:CleanerStore, readonly grants:CleanerGrants, readonly bindings:ProviderBinding[], readonly now:()=>number = Date.now, limits:Partial<CleanerLimits> = {}) {
    this.limits = {...defaults,...limits};
    for (const v of Object.values(this.limits)) if (!Number.isSafeInteger(v) || v <= 0) throw new Error('Positive integer limits required');
    if (new Set(bindings.map(b=>b.id)).size !== bindings.length || new Set(bindings.map(b=>JSON.stringify([b.account,b.number]))).size !== bindings.length) throw new Error('Unique provider bindings required');
    this.store.tx(() => {
      for (const b of bindings) {
        z.strictObject({id:AgentId,tenantId:AgentId,account:z.string().min(1),number:z.string().min(1),recipient:z.string().min(1),ingressSecret:z.string().min(32),credentialEpoch:z.string().min(1),guarantee:z.enum(['idempotent','non_idempotent']),send:z.custom<ProviderBinding['send']>(v=>typeof v==='function')}).parse(b);
        const old = store.one<{tenant:string;account:string;number:string;recipient:string;guarantee:string;credential_epoch:string}>('SELECT * FROM bindings WHERE id=?',b.id);
        if (old && JSON.stringify([old.tenant,old.account,old.number,old.recipient,old.guarantee,old.credential_epoch]) !== JSON.stringify([b.tenantId,b.account,b.number,b.recipient,b.guarantee,b.credentialEpoch])) throw new Error('Provider rebinding requires explicit migration/reconciliation');
        store.run('INSERT OR IGNORE INTO bindings VALUES(?,?,?,?,?,?,?)',b.id,b.tenantId,b.account,b.number,b.recipient,b.guarantee,b.credentialEpoch);
      }
    });
  }
  private audit(w:Work,type:string,actor='engine') { this.store.run('INSERT INTO audit(tenant,work_id,at,type,actor) VALUES(?,?,?,?,?)',w.tenantId,w.id,new Date(this.now()).toISOString(),type,actor); }
  private work(tenant:string,id:string):Work {
    const r=this.store.one<WorkRow>('SELECT data,binding FROM work WHERE tenant=? AND id=?',tenant,id);
    if (!r) throw new DelegationError('NOT_FOUND','No owned work.');
    const reply=this.store.one<{data:string}>('SELECT data FROM outbox WHERE tenant=? AND work_id=?',tenant,id);
    return WorkSchema.parse({...JSON.parse(r.data),...(reply ? {reply:JSON.parse(reply.data)} : {}),audit:[]});
  }
  private turn(w:Work):PrototypeTurn {
    const r=this.store.one<{data:string}>('SELECT data FROM turns WHERE tenant=? AND id=?',w.tenantId,w.turnId);
    if (!r) throw new DelegationError('TURN_MISSING','No authoritative turn.');
    return TurnSchema.parse(JSON.parse(r.data));
  }
  private save(w:Work) {
    const {reply,audit:_audit,...data}=w;
    this.store.run('UPDATE work SET status=?,lease_until=?,data=? WHERE tenant=? AND id=?',w.status,w.lease?.expiresAt??null,JSON.stringify(data),w.tenantId,w.id);
    if (reply) this.store.run('INSERT INTO outbox(tenant,work_id,binding,status,due,data) SELECT tenant,id,binding,?,?,? FROM work WHERE tenant=? AND id=? ON CONFLICT(tenant,work_id) DO UPDATE SET status=excluded.status,due=excluded.due,data=excluded.data',reply.status,reply.nextAttemptAt,JSON.stringify(reply),w.tenantId,w.id);
  }
  private refresh(tenant?:string,id?:string) {
    const rows = id ? this.store.all<{tenant:string;id:string}>('SELECT tenant,id FROM work WHERE tenant=? AND id=? AND status IN (?,?)',tenant!,id,'pending','leased')
      : this.store.all<{tenant:string;id:string}>(`SELECT tenant,id FROM work WHERE status IN ('pending','leased') AND (deadline<=? OR lease_until<=?) ${tenant?'AND tenant=?':''} ORDER BY deadline,id LIMIT 64`,this.now(),this.now(),...(tenant?[tenant]:[]));
    for (const r of rows) {
      const w=this.work(r.tenant,r.id);
      if (this.now()>=w.deadlineAt) {
        delete w.lease; w.status='reply_pending';
        w.reply={key:`reply_${w.id}`,recipient:this.turn(w).recipient,source:'fallback',status:'pending',attempts:0,nextAttemptAt:this.now(),text:'Your cleaning time change is awaiting host review. Your existing time is unchanged. Entry still requires host clearance.'};
        this.save(w);this.audit(w,'deadline_fallback_selected');
      } else if (w.lease && (this.now()>=w.lease.expiresAt || !this.store.one('SELECT id FROM grants WHERE id=? AND revoked=0 AND expires>?',w.lease.owner,this.now()))) {
        delete w.lease;w.status='pending';this.save(w);this.audit(w,'lease_expired_or_grant_revoked');
      }
    }
  }
  private view(w:Work) {
    const {tenantId:_tenant,recipient:_recipient,...turn}=this.turn(w);
    return {id:w.id,eventType:'cleaner.reschedule_requested',requestedStart:w.requestedStart,receivedAt:w.receivedAt,deadlineAt:new Date(w.deadlineAt).toISOString(),status:w.status,turn,...(w.reply?{decisionSource:w.reply.source,deliveryStatus:w.reply.status}:{})};
  }
  async saveTurn(owner:AgentIdentity,input:unknown):Promise<void> {
    const o=this.grants.validate(owner,'owner');
    const turn=TurnSchema.parse({...z.record(z.string(),z.unknown()).parse(input),tenantId:o.tenantId});
    if ((input as {tenantId?:string}).tenantId !== undefined) throw new DelegationError('INVALID_INPUT','Tenant is selected by the owner grant.');
    const bindings=this.bindings.filter(b=>b.tenantId===o.tenantId && b.recipient===turn.recipient);
    if (!bindings.length) throw new DelegationError('NOT_FOUND','Recipient needs an owned provider binding.');
    this.store.tx(()=>{
      const old=this.store.one<{version:number}>('SELECT version FROM turns WHERE tenant=? AND id=?',o.tenantId,turn.id);
      if(old && old.version>=turn.version) throw new DelegationError('VERSION_CONFLICT','Versions must increase.');
      this.store.run('INSERT INTO turns VALUES(?,?,?,?) ON CONFLICT(tenant,id) DO UPDATE SET version=excluded.version,data=excluded.data',o.tenantId,turn.id,turn.version,JSON.stringify(turn));
    });
  }
  /** Only a verified provider route calls this; authority is the immutable configured binding. */
  receive(binding:ProviderBinding,input:unknown) {
    if (!this.bindings.includes(binding)) throw new DelegationError('UNAUTHORIZED','Unknown provider.');
    const p=z.strictObject({eventId:z.string().min(1).max(200),turnId:AgentId,requestedStart:z.iso.datetime()}).parse(input);
    return this.store.tx(()=>{
      const prior=this.store.one<{id:string}>('SELECT id FROM work WHERE tenant=? AND binding=? AND source=?',binding.tenantId,binding.id,p.eventId);
      if (prior) {
        const w=this.work(binding.tenantId,prior.id);
        if(w.turnId!==p.turnId||w.requestedStart!==p.requestedStart) throw new DelegationError('SOURCE_CONFLICT','Source contents changed.');
        return w.id;
      }
      const id=`work_${createHash('sha256').update(JSON.stringify([binding.tenantId,binding.id,p.eventId])).digest('hex').slice(0,32)}`;
      const w:Work={id,tenantId:binding.tenantId,providerEventId:p.eventId,turnId:p.turnId,requestedStart:p.requestedStart,receivedAt:new Date(this.now()).toISOString(),deadlineAt:this.now()+this.limits.deadlineMs,status:'pending',audit:[]};
      if(this.turn(w).recipient!==binding.recipient)throw new DelegationError('NOT_FOUND','Turn recipient is not bound to this provider.');
      this.store.run('INSERT INTO work(tenant,id,binding,source,turn_id,status,deadline,data) VALUES(?,?,?,?,?,?,?,?)',w.tenantId,w.id,binding.id,p.eventId,w.turnId,w.status,w.deadlineAt,JSON.stringify(w));
      this.audit(w,'received','verified_provider');return id;
    });
  }
  async list(identity:AgentIdentity) {
    const i=this.grants.validate(identity);
    return this.store.tx(()=>{this.refresh(i.tenantId);return this.store.all<{id:string}>('SELECT id FROM work WHERE tenant=? AND status IN (?,?) AND deadline>? ORDER BY rowid',i.tenantId,'pending','leased',this.now()).map(r=>this.view(this.work(i.tenantId,r.id)));});
  }
  async get(identity:AgentIdentity,id:string) {
    const i=this.grants.validate(identity);
    return this.store.tx(()=>{this.refresh(i.tenantId,id);return this.view(this.work(i.tenantId,id));});
  }
  async evidence(identity:AgentIdentity,id:string) {
    const i=this.grants.validate(identity);
    return {work:await this.get(i,id),audit:this.store.all<{at:string;type:string;actor:string}>('SELECT at,type,actor FROM audit WHERE tenant=? AND work_id=? ORDER BY seq',i.tenantId,id),reply:this.store.one<{data:string}>('SELECT data FROM outbox WHERE tenant=? AND work_id=?',i.tenantId,id)?.data,carrierEvents:this.store.all('SELECT receipt,status,at FROM delivery_events WHERE tenant=? AND work_id=? ORDER BY seq',i.tenantId,id)};
  }
  async claim(identity:AgentIdentity,id:string) {
    const i=this.grants.validate(identity,'agent');
    return this.store.tx(()=>{
      this.refresh(i.tenantId,id);const w=this.work(i.tenantId,id);
      if(w.status==='leased'&&w.lease?.owner!==i.grantId)throw new DelegationError('LEASE_BUSY','Another grant owns the lease.');
      if(!['pending','leased'].includes(w.status))throw new DelegationError('CLOSED','Work is closed.');
      const predecessor=this.store.one('SELECT id FROM work WHERE tenant=? AND turn_id=? AND rowid<(SELECT rowid FROM work WHERE tenant=? AND id=?) AND status IN (?,?,?) LIMIT 1',i.tenantId,w.turnId,i.tenantId,w.id,'pending','leased','reply_pending');
      if(predecessor)throw new DelegationError('ENTITY_BUSY','Earlier source work on this turn must settle first.');
      if(!w.lease){w.lease={owner:i.grantId,token:randomUUID(),expiresAt:Math.min(w.deadlineAt,this.now()+this.limits.leaseMs)};w.status='leased';this.save(w);this.audit(w,'claimed',i.agentId);}
      return {...this.view(w),leaseToken:w.lease!.token,leaseExpiresAt:new Date(w.lease!.expiresAt).toISOString()};
    });
  }
  async propose(identity:AgentIdentity,input:{id:string;leaseToken:string;actionKey:string;expectedTurnVersion:number;start:string}) {
    const i=this.grants.validate(identity,'agent');
    const p=z.strictObject({id:AgentId,leaseToken:z.string().min(1),actionKey:AgentId,expectedTurnVersion:z.number().int().positive(),start:z.iso.datetime()}).parse(input);
    return this.store.tx(()=>{
      this.refresh(i.tenantId,p.id);const w=this.work(i.tenantId,p.id);
      const fingerprint=createHash('sha256').update(JSON.stringify([i.grantId,p.id,p.leaseToken,p.expectedTurnVersion,p.start])).digest('hex');
      const prior=this.store.one<{work_id:string;fingerprint:string}>('SELECT * FROM actions WHERE tenant=? AND key=?',i.tenantId,p.actionKey);
      if(prior){if(prior.work_id!==p.id||prior.fingerprint!==fingerprint)throw new DelegationError('ACTION_CONFLICT','Action key changed.');return {accepted:true,completed:w.status==='completed',deliveryStatus:w.reply!.status};}
      if(w.status!=='leased'||w.lease?.owner!==i.grantId||w.lease.token!==p.leaseToken)throw new DelegationError('LEASE_INVALID','Claim current work.');
      const t=this.turn(w);if(t.version!==p.expectedTurnVersion)throw new DelegationError('VERSION_CONFLICT','Turn changed.');
      const start=Date.parse(p.start),end=start+t.minimumMinutes*60000;
      if(start<=this.now()||start<Date.parse(t.windowStart)||end>Date.parse(t.windowEnd)||end>Date.parse(t.nextArrival))throw new DelegationError('SLOT_INVALID','Slot violates current constraints.');
      t.confirmedStart=p.start;t.version++;
      this.store.run('UPDATE turns SET version=?,data=? WHERE tenant=? AND id=?',t.version,JSON.stringify(t),i.tenantId,t.id);
      this.store.run('INSERT INTO actions VALUES(?,?,?,?)',i.tenantId,p.actionKey,p.id,fingerprint);
      w.decision={actionKey:p.actionKey,fingerprint,start:p.start};delete w.lease;w.status='reply_pending';
      const label=new Intl.DateTimeFormat('en-US',{timeZone:t.timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(start));
      w.reply={key:`reply_${w.id}`,recipient:t.recipient,turnVersion:t.version,source:'agent',status:'pending',attempts:0,nextAttemptAt:this.now(),text:`Cleaning scheduled for ${label} (${t.timeZone}). Entry requires host clearance.`};
      this.save(w);this.audit(w,'validated_action_and_reply_saved',i.agentId);
      return {accepted:true,completed:false,deliveryStatus:w.reply.status};
    });
  }
  private review(w:Work,type:string) {w.status='review_required';w.reply!.status='review_required';this.save(w);this.audit(w,type);}
  private reserve(tenant:string):{w:Work;binding:ProviderBinding;token:string}|undefined {
    return this.store.tx(()=>{
      this.refresh(tenant);
      const r=this.store.one<OutboxRow>("SELECT * FROM outbox WHERE tenant=? AND status IN ('pending','sending') AND due<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY due,work_id LIMIT 1",tenant,this.now(),this.now());
      if(!r)return;
      const w=this.work(tenant,r.work_id),reply=w.reply!,binding=this.bindings.find(b=>b.id===r.binding&&b.tenantId===tenant);
      if(!binding){this.review(w,'provider_binding_unavailable');return;}
      if(reply.status==='sending'&&binding.guarantee!=='idempotent'){this.review(w,'ambiguous_delivery_requires_review');return;}
      if(reply.attempts===0&&reply.source==='agent'&&this.turn(w).version!==reply.turnVersion){this.review(w,'booking_changed_before_delivery');return;}
      if(reply.attempts>=this.limits.maxAttempts){this.review(w,'delivery_attempts_exhausted');return;}
      if(!this.store.consume(tenant,'sends',this.now(),this.limits.sendsPerSecond))return;
      reply.status='sending';reply.attempts++;this.save(w);this.audit(w,'send_attempt');
      const token=randomUUID();this.store.run('UPDATE outbox SET attempt_token=?,lease_until=? WHERE tenant=? AND work_id=?',token,this.now()+this.limits.sendTimeoutMs+1000,tenant,w.id);
      return {w,binding,token};
    });
  }
  private async send(job:{w:Work;binding:ProviderBinding;token:string}) {
    const {w,binding,token}=job,reply=w.reply!,controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    let receipt:string|undefined,error:unknown;
    try {
      this.transports.add(w.tenantId);
      const transport=Promise.resolve().then(()=>binding.send({key:reply.key,tenantId:w.tenantId,from:binding.number,recipient:reply.recipient,text:reply.text,signal:controller.signal})).finally(()=>this.transports.delete(w.tenantId));
      const result=await Promise.race([transport,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Provider timeout'));},this.limits.sendTimeoutMs);})]);
      if(!result.receipt)throw new Error('Missing receipt');receipt=result.receipt;
    }catch(e){error=e;}finally{if(timer)clearTimeout(timer);}
    this.store.tx(()=>{
      const r=this.store.one<OutboxRow>('SELECT * FROM outbox WHERE tenant=? AND work_id=? AND attempt_token=? AND status=?',w.tenantId,w.id,token,'sending');
      if(!r)return; // A stale worker cannot overwrite another attempt or operator state.
      const current=this.work(w.tenantId,w.id),out=current.reply!;
      if(receipt){out.receipt=receipt;out.status='sent';current.status='completed';this.save(current);this.audit(current,'provider_accepted_and_completed');}
      else if((binding.guarantee==='idempotent'||error instanceof DefinitelyNotAccepted)&&out.attempts<this.limits.maxAttempts){out.status='pending';out.nextAttemptAt=this.now()+this.limits.retryMs*2**(out.attempts-1);this.save(current);this.audit(current,'send_failed_retry_scheduled');}
      else this.review(current,'ambiguous_delivery_or_exhaustion_requires_review');
      this.store.run('UPDATE outbox SET attempt_token=NULL,lease_until=NULL WHERE tenant=? AND work_id=? AND attempt_token=?',w.tenantId,w.id,token);
    });
  }
  /** One lane per tenant and round-robin admission; no provider await owns a DB transaction. */
  async tick():Promise<void> {
    const tenants=this.store.all<{id:string}>('SELECT id FROM tenants ORDER BY id');
    if(!tenants.length)return;
    for(const t of tenants)this.store.tx(()=>this.refresh(t.id));
    const tasks:Promise<void>[]=[];
    const start=this.cursor;
    for(let n=0;n<tenants.length&&new Set([...this.active.keys(),...this.transports]).size<this.limits.globalConcurrency;n++) {
      const index=(start+n)%tenants.length,tenant=tenants[index]!.id;
      if(this.active.has(tenant)||this.transports.has(tenant))continue;
      const job=this.reserve(tenant);if(!job)continue;
      const task=this.send(job).finally(()=>{this.active.delete(tenant);});this.active.set(tenant,task);tasks.push(task);this.cursor=(index+1)%tenants.length;
    }
    await Promise.all(tasks);
  }
  async drain(){await Promise.all(this.active.values());}
  delivery(binding:ProviderBinding,input:unknown) {
    const p=z.strictObject({workId:AgentId,receipt:z.string().min(1),status:z.enum(['delivered','failed','undelivered']),eventId:z.string().min(1).max(200).optional()}).parse(input);
    this.store.tx(()=>{
      const r=this.store.one<OutboxRow>('SELECT * FROM outbox WHERE tenant=? AND work_id=? AND binding=?',binding.tenantId,p.workId,binding.id);
      if(!r||JSON.parse(r.data).receipt!==p.receipt)throw new DelegationError('NOT_FOUND','No matching owned receipt.');
      const source=p.eventId??createHash('sha256').update(JSON.stringify([p.receipt,p.status])).digest('hex');
      const prior=this.store.one<{work_id:string;receipt:string;status:string}>('SELECT work_id,receipt,status FROM delivery_events WHERE tenant=? AND binding=? AND source=?',binding.tenantId,binding.id,source);
      if(prior){if(prior.work_id!==p.workId||prior.receipt!==p.receipt||prior.status!==p.status)throw new DelegationError('SOURCE_CONFLICT','Delivery source contents changed.');return;}
      this.store.run('INSERT INTO delivery_events(tenant,work_id,binding,source,receipt,status,at) VALUES(?,?,?,?,?,?,?)',binding.tenantId,p.workId,binding.id,source,p.receipt,p.status,this.now());
      const w=this.work(binding.tenantId,p.workId);
      this.audit(w,`carrier_${p.status}`,'verified_provider'); // Never authorizes a duplicate send.
    });
    return {recorded:true};
  }
}
