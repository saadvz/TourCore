import { randomUUID } from 'node:crypto';
import { CleanerStore } from './store';
import { CleanerProfiles } from './profiles';
import { CleanerEngine } from './engine';
import { CleanerGrants } from './grants';
import { DelegationError, type AgentIdentity } from '../prototype';
import { grokWorkEvent } from '../../agents/grok';
export interface AgentWakeup {tenantId:string;agentId:string;notify(event:ReturnType<typeof grokWorkEvent>,signal:AbortSignal):Promise<number>}
interface Notification {tenant:string;work_id:string;agent:string;epoch:number;status:string;attempts:number;token:string|null;lease_until:number|null;due:number;http:number|null;attempted_at:number|null;accepted_at:number|null;onboarding:number}
/** Indexed tenant/work/adapter wakeups. 2xx means transport acceptance only. */
export class CleanerNotifications {
  private active=new Map<string,Promise<void>>();private cursor=0;
  private transports=new Set<string>();
  constructor(readonly store:CleanerStore,readonly grants:CleanerGrants,readonly profiles:CleanerProfiles,readonly engine:CleanerEngine,readonly routes:AgentWakeup[],readonly now:()=>number=Date.now,readonly timeoutMs=5000) {
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||new Set(routes.map(r=>JSON.stringify([r.tenantId,r.agentId]))).size!==routes.length)throw new Error('Unique wakeup routes and positive timeout required');
  }
  private eligible(route:AgentWakeup) {
    if(!this.store.one('SELECT id FROM grants WHERE tenant=? AND agent=? AND role=? AND revoked=0 AND expires>?',route.tenantId,route.agentId,'agent',this.now()))return false;
    return this.profiles.readiness(route.tenantId,route.agentId,this.engine.limits.deadlineMs).readiness.executionMode==='autonomous';
  }
  /** Owner can send a single onboarding challenge before eligibility, without claiming autonomy. */
  onboarding(owner:AgentIdentity,workId:string,agentId:string) {
    const o=this.grants.validate(owner,'owner');
    if(!this.store.one('SELECT id FROM work WHERE tenant=? AND id=?',o.tenantId,workId)||!this.routes.some(r=>r.tenantId===o.tenantId&&r.agentId===agentId))throw new DelegationError('NOT_FOUND','No owned work/route.');
    this.queue(o.tenantId,workId,agentId,true);
    return {queued:true,mode:'owner_requested_onboarding'};
  }
  private queue(tenant:string,workId:string,agent:string,onboarding=false) {
    const a=this.store.one<{epoch:number}>('SELECT epoch FROM agents WHERE tenant=? AND id=?',tenant,agent);
    if(!a)throw new DelegationError('NOT_FOUND','No owned agent.');
    this.store.run("INSERT INTO notifications(tenant,work_id,agent,epoch,status,due,onboarding) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant,work_id,agent) DO UPDATE SET epoch=excluded.epoch,status=excluded.status,due=excluded.due,attempts=0,onboarding=excluded.onboarding WHERE notifications.epoch<>excluded.epoch OR notifications.status='cancelled'",tenant,workId,agent,a.epoch,'pending',this.now(),onboarding?1:0);
  }
  status(owner:AgentIdentity,id:string,agent:string) {
    const o=this.grants.validate(owner,'owner');
    if(!this.store.one('SELECT id FROM work WHERE tenant=? AND id=?',o.tenantId,id))throw new DelegationError('NOT_FOUND','No owned work.');
    return this.store.one<Notification>('SELECT tenant,work_id,agent,epoch,status,due,attempts,http,attempted_at,accepted_at FROM notifications WHERE tenant=? AND work_id=? AND agent=?',o.tenantId,id,agent)??{status:'not_queued'};
  }
  private reserve(route:AgentWakeup) {
    return this.store.tx(()=>{
      if(this.eligible(route))for(const w of this.store.all<{id:string}>("SELECT id FROM work WHERE tenant=? AND status='pending' AND deadline>?",route.tenantId,this.now()))this.queue(route.tenantId,w.id,route.agentId);
      const n=this.store.one<Notification>("SELECT * FROM notifications WHERE tenant=? AND agent=? AND status IN ('pending','sending') AND due<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY due,work_id LIMIT 1",route.tenantId,route.agentId,this.now(),this.now());
      if(!n)return;
      const w=this.store.one<{status:string;deadline:number}>('SELECT status,deadline FROM work WHERE tenant=? AND id=?',n.tenant,n.work_id);
      const a=this.store.one<{epoch:number}>('SELECT epoch FROM agents WHERE tenant=? AND id=?',n.tenant,n.agent);
      const live=this.store.one('SELECT id FROM grants WHERE tenant=? AND agent=? AND role=? AND epoch=? AND revoked=0 AND expires>?',n.tenant,n.agent,'agent',n.epoch,this.now());
      if(!w||!a||a.epoch!==n.epoch||!live||(!n.onboarding&&!this.eligible(route))||w.deadline<=this.now()||!['pending','leased'].includes(w.status)){this.store.run("UPDATE notifications SET status='cancelled' WHERE tenant=? AND work_id=? AND agent=?",n.tenant,n.work_id,n.agent);return;}
      if(n.attempts>=3){this.store.run("UPDATE notifications SET status='failed' WHERE tenant=? AND work_id=? AND agent=?",n.tenant,n.work_id,n.agent);return;}
      if(!this.store.consume(n.tenant,'wakeups',this.now(),2))return;
      const token=randomUUID();this.store.run("UPDATE notifications SET status='sending',attempts=attempts+1,token=?,lease_until=?,attempted_at=? WHERE tenant=? AND work_id=? AND agent=?",token,this.now()+this.timeoutMs+1000,this.now(),n.tenant,n.work_id,n.agent);
      return {n,token,deadline:new Date(w.deadline).toISOString()};
    });
  }
  private async dispatch(route:AgentWakeup,job:NonNullable<ReturnType<CleanerNotifications['reserve']>>) {
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,http:number|undefined;
    try{
      this.transports.add(route.tenantId);
      const transport=Promise.resolve().then(()=>route.notify(grokWorkEvent({id:job.n.work_id,deadlineAt:job.deadline}),controller.signal)).finally(()=>this.transports.delete(route.tenantId));
      http=await Promise.race([transport,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Wakeup timeout'));},this.timeoutMs);})]);
    }catch{}finally{if(timer)clearTimeout(timer);}
    this.store.tx(()=>{
      const n=this.store.one<Notification>("SELECT * FROM notifications WHERE tenant=? AND work_id=? AND agent=? AND token=? AND status='sending'",job.n.tenant,job.n.work_id,job.n.agent,job.token);
      if(!n)return;
      const accepted=http!==undefined&&http>=200&&http<300,retryable=http===undefined||http===408||http===429||http>=500;
      this.store.run('UPDATE notifications SET status=?,due=?,http=?,accepted_at=?,token=NULL,lease_until=NULL WHERE tenant=? AND work_id=? AND agent=? AND token=?',accepted?'accepted':retryable&&n.attempts<3?'pending':'failed',this.now()+1000*2**(n.attempts-1),http??null,accepted?this.now():null,n.tenant,n.work_id,n.agent,job.token);
    });
  }
  async tick() {
    const tasks:Promise<void>[]=[];if(!this.routes.length)return;
    const start=this.cursor;
    for(let n=0;n<this.routes.length&&new Set([...this.active.keys(),...this.transports]).size<this.engine.limits.globalConcurrency;n++){
      const index=(start+n)%this.routes.length,route=this.routes[index]!;
      if(this.active.has(route.tenantId)||this.transports.has(route.tenantId))continue;
      const job=this.reserve(route);if(!job)continue;
      const task=this.dispatch(route,job).finally(()=>{this.active.delete(route.tenantId);});this.active.set(route.tenantId,task);tasks.push(task);this.cursor=(index+1)%this.routes.length;
    }
    await Promise.all(tasks);
  }
  async drain(){await Promise.all(this.active.values());}
}
