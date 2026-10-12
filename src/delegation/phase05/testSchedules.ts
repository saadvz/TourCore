import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DelegationError, type AgentIdentity } from '../prototype';
import { CleanerGrants } from './grants';
import { CleanerStore } from './store';

export const FIXTURE_SCHEDULER_VERSION = 'server-clock-v1';
export interface FixtureTimers {
  set(callback:()=>void, delayMs:number):ReturnType<typeof setTimeout>;
  clear(timer:ReturnType<typeof setTimeout>):void;
}
interface Schedule {
  tenant:string; id:string; event_id:string; kind:'onboarding'|'ordinary'; delay_seconds:number;
  owner_grant_id:string; owner_agent:string; run_at:number;
  status:'scheduled'|'fired'|'expired'|'cancelled'|'failed';
  work_id:string|null; fired_at:number|null; error:string|null;
}
interface Hooks {
  deadlineMs:number;
  hasWakeup(tenant:string):boolean;
  findFixture(tenant:string,eventId:string):{id:string;status:string;deadline:number}|undefined;
  createFixture(owner:AgentIdentity,eventId:string):string;
  prepareOnboarding(owner:AgentIdentity,workId:string):void;
}
const Request = z.strictObject({
  eventId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  delaySeconds:z.number().int().min(30).max(1200).default(300),
  kind:z.enum(['onboarding','ordinary']).default('onboarding'),
});

/** Synthetic-test fixture timing only. The engine still owns work deadlines and effects. */
export class CleanerTestSchedules {
  private timer?:ReturnType<typeof setTimeout>;
  private running=false;
  healthy=true;
  constructor(readonly store:CleanerStore,readonly grants:CleanerGrants,readonly hooks:Hooks,
    readonly now:()=>number=Date.now,readonly agentId='grok_test_agent',
    readonly timers:FixtureTimers={set:(fn,ms)=>setTimeout(fn,ms),clear:t=>clearTimeout(t)}) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS test_fixture_schedules(
      tenant TEXT NOT NULL REFERENCES tenants(id), id TEXT NOT NULL, event_id TEXT NOT NULL,
      kind TEXT NOT NULL, delay_seconds INTEGER NOT NULL, owner_grant_id TEXT NOT NULL REFERENCES grants(id),
      owner_agent TEXT NOT NULL, run_at INTEGER NOT NULL, status TEXT NOT NULL,
      work_id TEXT, fired_at INTEGER, error TEXT,
      PRIMARY KEY(tenant,id), UNIQUE(tenant,event_id),
      FOREIGN KEY(tenant,work_id) REFERENCES work(tenant,id));
      CREATE INDEX IF NOT EXISTS test_fixture_schedules_due ON test_fixture_schedules(status,run_at,tenant);
    `);
  }
  private view(job:Schedule) {
    return {id:job.id,eventId:job.event_id,kind:job.kind,delaySeconds:job.delay_seconds,
      runAt:new Date(job.run_at).toISOString(),status:job.status,workId:job.work_id,
      firedAt:job.fired_at===null?null:new Date(job.fired_at).toISOString(),error:job.error};
  }
  private requireLiveAgent(tenant:string,through:number) {
    if(!this.store.one(`SELECT g.id FROM grants g JOIN agents a ON a.tenant=g.tenant AND a.id=g.agent AND a.epoch=g.epoch
      WHERE g.tenant=? AND g.agent=? AND g.role='agent' AND g.revoked=0 AND g.expires>?`,tenant,this.agentId,through))
      throw new DelegationError('UNAUTHORIZED','Mint a live agent grant covering the scheduled fixture and its deadline.');
  }
  enqueue(owner:AgentIdentity,input:unknown) {
    const o=this.grants.validate(owner,'owner'),p=Request.parse(input);
    if(!this.healthy)throw new DelegationError('UNAVAILABLE','Fixture scheduler is unavailable.');
    const job=this.store.tx(()=>{
      const prior=this.store.one<Schedule>('SELECT * FROM test_fixture_schedules WHERE tenant=? AND event_id=?',o.tenantId,p.eventId);
      if(prior) {
        if(prior.kind!==p.kind||prior.delay_seconds!==p.delaySeconds)throw new DelegationError('SOURCE_CONFLICT','Scheduled event contents changed.');
        return prior;
      }
      if(!this.hooks.hasWakeup(o.tenantId))throw new DelegationError('NOT_FOUND','No configured synthetic wakeup route.');
      if(this.hooks.findFixture(o.tenantId,p.eventId))throw new DelegationError('SOURCE_CONFLICT','Fixture already exists; preserve its original evidence.');
      const count=this.store.one<{n:number}>("SELECT COUNT(*) n FROM test_fixture_schedules WHERE tenant=? AND status='scheduled'",o.tenantId)!.n;
      const onboarding=this.store.one<{n:number}>("SELECT COUNT(*) n FROM test_fixture_schedules WHERE tenant=? AND status='scheduled' AND kind='onboarding'",o.tenantId)!.n;
      if(count>=12||(p.kind==='onboarding'&&onboarding>=1))throw new DelegationError('RATE_LIMIT','Tenant scheduled-fixture limit reached.');
      const runAt=this.now()+p.delaySeconds*1000;
      this.requireLiveAgent(o.tenantId,runAt+this.hooks.deadlineMs);
      const id=`test_schedule_${createHash('sha256').update(JSON.stringify([o.tenantId,p.eventId])).digest('hex').slice(0,32)}`;
      this.store.run(`INSERT INTO test_fixture_schedules(tenant,id,event_id,kind,delay_seconds,owner_grant_id,owner_agent,run_at,status)
        VALUES(?,?,?,?,?,?,?,?,'scheduled')`,o.tenantId,id,p.eventId,p.kind,p.delaySeconds,o.grantId,o.agentId,runAt);
      return this.store.one<Schedule>('SELECT * FROM test_fixture_schedules WHERE tenant=? AND id=?',o.tenantId,id)!;
    });
    this.arm();return this.view(job);
  }
  read(owner:AgentIdentity,id:string) {
    const o=this.grants.validate(owner,'owner'),job=this.store.one<Schedule>('SELECT * FROM test_fixture_schedules WHERE tenant=? AND id=?',o.tenantId,id);
    if(!job)throw new DelegationError('NOT_FOUND','No owned scheduled fixture.');
    return this.view(job);
  }
  cancel(owner:AgentIdentity,id:string) {
    const o=this.grants.validate(owner,'owner');this.read(o,id);
    if(!this.store.run("UPDATE test_fixture_schedules SET status='cancelled' WHERE tenant=? AND id=? AND status='scheduled'",o.tenantId,id).changes)
      throw new DelegationError('CLOSED','Scheduled fixture already settled; preserve existing work.');
    this.arm();return this.read(o,id);
  }
  /** One due job per tenant per pass; no provider/network awaits and no global snapshot. */
  pump() {
    if(!this.healthy)throw new DelegationError('UNAVAILABLE','Fixture scheduler is unavailable.');
    const seen=new Set<string>();
    const due=this.store.all<Schedule>("SELECT * FROM test_fixture_schedules WHERE status='scheduled' AND run_at<=? ORDER BY run_at,tenant,id LIMIT 24",this.now());
    for(const job of due) {
      if(seen.has(job.tenant))continue;seen.add(job.tenant);
      let workId:string|null=null;
      try {
        const owner=this.grants.validate({tenantId:job.tenant,agentId:job.owner_agent,grantId:job.owner_grant_id} as AgentIdentity,'owner');
        const existing=this.hooks.findFixture(job.tenant,job.event_id);workId=existing?.id??null;
        // A late host restart cannot silently create a later test. A partially committed
        // fixture may resume setup only inside its original, already durable deadline.
        if((!existing&&this.now()-job.run_at>5000)||(existing&&(existing.deadline<=this.now()||!['pending','leased'].includes(existing.status)))) {
          this.store.run("UPDATE test_fixture_schedules SET status='expired',work_id=?,error='SCHEDULE_WINDOW_MISSED' WHERE tenant=? AND id=? AND status='scheduled'",workId,job.tenant,job.id);
          continue;
        }
        this.requireLiveAgent(job.tenant,(existing?.deadline??this.now()+this.hooks.deadlineMs));
        workId=this.hooks.createFixture(owner,job.event_id);
        // Source creation commits separately; the durable scheduled record recovers the
        // same source after a crash. Probe, wakeup and fired marker commit together.
        this.store.tx(()=>{
          const current=this.store.one<Schedule>('SELECT * FROM test_fixture_schedules WHERE tenant=? AND id=?',job.tenant,job.id);
          if(current?.status!=='scheduled')return;
          const fixture=this.hooks.findFixture(job.tenant,job.event_id);
          if(!fixture||fixture.deadline<=this.now()||!['pending','leased'].includes(fixture.status)) {
            this.store.run("UPDATE test_fixture_schedules SET status='expired',work_id=?,error='SCHEDULE_WINDOW_MISSED' WHERE tenant=? AND id=? AND status='scheduled'",workId,job.tenant,job.id);
            return;
          }
          this.grants.validate(owner,'owner');this.requireLiveAgent(job.tenant,fixture.deadline);
          if(job.kind==='onboarding')this.hooks.prepareOnboarding(owner,workId!);
          this.store.run("UPDATE test_fixture_schedules SET status='fired',work_id=?,fired_at=? WHERE tenant=? AND id=? AND status='scheduled'",workId,this.now(),job.tenant,job.id);
        });
      } catch(error) {
        if(!(error instanceof DelegationError))throw error;
        this.store.run("UPDATE test_fixture_schedules SET status='failed',work_id=?,error=? WHERE tenant=? AND id=? AND status='scheduled'",workId,error.code,job.tenant,job.id);
      }
    }
  }
  start(){this.running=true;this.arm();}
  stop(){this.running=false;if(this.timer)this.timers.clear(this.timer);this.timer=undefined;}
  private arm() {
    if(this.timer)this.timers.clear(this.timer);this.timer=undefined;
    if(!this.running||!this.healthy)return;
    const next=this.store.one<{run_at:number}>("SELECT run_at FROM test_fixture_schedules WHERE status='scheduled' ORDER BY run_at LIMIT 1");
    if(!next)return;
    this.timer=this.timers.set(()=>{
      this.timer=undefined;if(!this.running)return;
      try{this.pump();}catch{this.healthy=false;return;}
      this.arm();
    },Math.max(1,next.run_at-this.now()));
    this.timer.unref?.();
  }
}
