import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AgentProfile, agentReadiness, CapabilityDeclaration, Capability, AgentId, type AgentProfile as Profile, type CapabilityEvidence } from '../../agents/profile';
import { DelegationError, type AgentIdentity } from '../prototype';
import { CleanerStore } from './store';
import { CleanerGrants, digest } from './grants';
import type { CleanerEngine } from './engine';

interface Probe {id:string;capability:Capability;nonceHash:string;status:string;expectedWorkId?:string;scenario?:{requestedStart:string;windowStart:string;windowEnd:string;minimumMinutes:number}}
export class CleanerProfiles {
  constructor(readonly store:CleanerStore, readonly grants:CleanerGrants, readonly now:()=>number=Date.now, readonly validityMs=86400000) {if(!Number.isSafeInteger(validityMs)||validityMs<=0)throw new Error('Positive validity required');}
  private profile(identity:AgentIdentity):Profile {
    const a=this.store.one<{epoch:number;adapter:'grok'|'generic_mcp'}>('SELECT epoch,adapter FROM agents WHERE tenant=? AND id=?',identity.tenantId,identity.agentId);
    if(!a)throw new DelegationError('NOT_FOUND','No owned agent.');
    const r=this.store.one<{epoch:number;data:string}>('SELECT * FROM profiles WHERE tenant=? AND agent=?',identity.tenantId,identity.agentId);
    if(r?.epoch===a.epoch)return AgentProfile.parse(JSON.parse(r.data));
    const at=new Date(this.now()).toISOString();
    const profile:Profile={schemaVersion:1,tenantId:identity.tenantId,agentId:identity.agentId,adapterId:a.adapter,createdAt:at,updatedAt:at,capabilities:Capability.options.map(capability=>({capability,declared:'unknown'})),nativeExtensions:[],grants:[]};
    // Persist even an unverified profile. Ordinary reads and OAuth refresh do
    // not create a new capability epoch or change its creation timestamp.
    this.save(profile);
    return profile;
  }
  private save(p:Profile) {
    // Strip authentication fields before parsing/saving the public profile.
    p=AgentProfile.parse(p);
    const epoch=this.store.one<{epoch:number}>('SELECT epoch FROM agents WHERE tenant=? AND id=?',p.tenantId,p.agentId)!.epoch;
    this.store.run('INSERT INTO profiles VALUES(?,?,?,?) ON CONFLICT(tenant,agent) DO UPDATE SET epoch=excluded.epoch,data=excluded.data',p.tenantId,p.agentId,epoch,JSON.stringify(p));
  }
  private evidence(p:Profile,capability:Capability,input:Omit<CapabilityEvidence,'expiresAt'>) {
    p.capabilities.find(c=>c.capability===capability)!.evidence={...input,expiresAt:new Date(Date.parse(input.observedAt)+this.validityMs).toISOString()};
    p.updatedAt=new Date(this.now()).toISOString();
  }
  async get(identity:AgentIdentity,deadlineMs=120000) {this.grants.validate(identity);return agentReadiness(this.profile({tenantId:identity.tenantId,agentId:identity.agentId}),this.now(),deadlineMs);}
  async declare(identity:AgentIdentity,input:unknown) {
    this.grants.validate(identity,'agent');const d=CapabilityDeclaration.parse(input);
    if(d.nativeExtensions?.length)throw new DelegationError('UNSUPPORTED','External native connectors are not enabled in the local demonstration.');
    const p=this.profile({tenantId:identity.tenantId,agentId:identity.agentId});
    for(const c of d.capabilities){const r=p.capabilities.find(r=>r.capability===c.capability)!;r.declared=c.availability;if(c.availability!=='available')delete r.evidence;}
    this.save(p);return this.get(identity);
  }
  async begin(identity:AgentIdentity,input:unknown) {
    const i=this.grants.validate(identity,'agent');
    const request=z.strictObject({capability:Capability,extensionId:AgentId.optional()}).parse(input);
    if(!['mcp_tools','generation_reasoning'].includes(request.capability)||request.extensionId)throw new DelegationError('WORKFLOW_REQUIRED','Use correlated owner-reviewed workflow evidence; optional native connectors are disabled.');
    const id=`probe_${randomUUID().replaceAll('-','')}`,nonce=randomBytes(24).toString('hex');
    const iso=(h:number)=>new Date(this.now()+h*3600000).toISOString();
    const scenario=request.capability==='generation_reasoning'?{requestedStart:iso(25),windowStart:iso(24),windowEnd:iso(30),minimumMinutes:90}:undefined;
    const probe:Probe={id,capability:request.capability,nonceHash:digest(nonce),status:'pending',...(scenario?{scenario}:{})};
    this.store.run('DELETE FROM probes WHERE expires<=?',this.now());
    if(this.store.one<{n:number}>('SELECT COUNT(*) n FROM probes WHERE tenant=?',i.tenantId)!.n>=32)throw new DelegationError('PROBE_LIMIT','Complete existing probes.');
    this.store.run('INSERT INTO probes VALUES(?,?,?,?,?,?)',id,i.tenantId,i.agentId,i.epoch,this.now()+600000,JSON.stringify(probe));
    return {probeId:id,nonce,capability:request.capability,deadlineAt:iso(1/6),...(scenario?{scenario}:{}),requiresOwnerReview:false};
  }
  async complete(identity:AgentIdentity,input:unknown) {
    const i=this.grants.validate(identity,'agent');
    const answer=z.strictObject({probeId:AgentId,nonce:z.string().regex(/^[a-f0-9]{48}$/),answer:z.strictObject({decision:z.enum(['propose_time','host_review']),draft:z.string().min(10).max(500)}).optional()}).parse(input);
    return this.store.tx(()=>{
      const r=this.store.one<{epoch:number;expires:number;data:string}>('SELECT * FROM probes WHERE id=? AND tenant=? AND agent=?',answer.probeId,i.tenantId,i.agentId);
      if(!r||r.epoch!==i.epoch)throw new DelegationError('NOT_FOUND','No owned probe.');
      if(r.expires<=this.now())throw new DelegationError('PROBE_EXPIRED','Start a fresh probe.');
      const probe:Probe=JSON.parse(r.data);
      if(probe.expectedWorkId)throw new DelegationError('INVALID_TRANSPORT','Use the configured connector to read the issued work.');
      if(probe.status!=='pending'||probe.nonceHash!==digest(answer.nonce))throw new DelegationError('PROBE_MISMATCH','Invalid or consumed probe.');
      const p=this.profile({tenantId:i.tenantId,agentId:i.agentId}),at=new Date(this.now()).toISOString();
      this.evidence(p,'mcp_tools',{status:'verified',method:'server_probe',evidenceId:probe.id,scope:'authenticated_read_only_roundtrip',observedAt:at});
      let passed=true;
      if(probe.capability==='generation_reasoning') {
        const text=answer.answer?.draft.toLowerCase()??'';
        passed=answer.answer?.decision==='propose_time'&&text.includes(probe.scenario!.requestedStart.toLowerCase())&&text.includes('host clearance');
        this.evidence(p,'generation_reasoning',{status:passed?'verified':'failed',method:'server_probe',evidenceId:probe.id,scope:'synthetic_policy_draft',observedAt:at});
      }
      probe.status=passed?'verified':'failed';this.save(p);
      this.store.run('UPDATE probes SET data=? WHERE id=?',JSON.stringify(probe),probe.id);
      return {probeId:probe.id,status:probe.status,sendsMessages:false};
    });
  }
  beginCoreRead(owner:AgentIdentity,agentId:string,workId:string) {
    const o=this.grants.validate(owner,'owner');AgentId.parse(agentId);AgentId.parse(workId);
    if(!this.store.one('SELECT id FROM work WHERE tenant=? AND id=?',o.tenantId,workId))throw new DelegationError('NOT_FOUND','No owned work.');
    const a=this.store.one<{epoch:number}>('SELECT epoch FROM agents WHERE tenant=? AND id=?',o.tenantId,agentId);
    if(!a)throw new DelegationError('NOT_FOUND','No owned agent.');
    const id=`probe_${randomUUID().replaceAll('-','')}`;
    const probe:Probe={id,capability:'mcp_tools',nonceHash:digest(randomBytes(24).toString('hex')),status:'pending',expectedWorkId:workId};
    this.store.run('DELETE FROM probes WHERE expires<=?',this.now());
    if(this.store.one<{n:number}>('SELECT COUNT(*) n FROM probes WHERE tenant=?',o.tenantId)!.n>=32)throw new DelegationError('PROBE_LIMIT','Complete existing probes.');
    this.store.run('INSERT INTO probes VALUES(?,?,?,?,?,?)',id,o.tenantId,agentId,a.epoch,this.now()+600000,JSON.stringify(probe));
    return {probeId:id,tool:'read_delegated_work',arguments:{id:workId},deadlineAt:new Date(this.now()+600000).toISOString()};
  }
  async observeCoreRead(identity:AgentIdentity,workId:string):Promise<void> {
    const i=this.grants.validate(identity,'agent');
    this.store.tx(()=>{
      const probes=this.store.all<{id:string;data:string}>('SELECT id,data FROM probes WHERE tenant=? AND agent=? AND epoch=? AND expires>?',i.tenantId,i.agentId,i.epoch,this.now());
      const p=this.profile({tenantId:i.tenantId,agentId:i.agentId});let changed=false;
      for(const row of probes){const probe:Probe=JSON.parse(row.data);if(probe.status!=='pending'||probe.expectedWorkId!==workId)continue;
        probe.status='verified';this.store.run('UPDATE probes SET data=? WHERE id=?',JSON.stringify(probe),row.id);
        this.evidence(p,'mcp_tools',{status:'verified',method:'server_probe',evidenceId:probe.id,scope:'authenticated_core_work_read',observedAt:new Date(this.now()).toISOString()});changed=true;
      }
      if(changed)this.save(p);
    });
  }
  /** A recorded workflow is evidence, never authority; no agent can self-attest unattended execution. */
  async verifyWorkflow(owner:AgentIdentity,input:unknown,engine:CleanerEngine) {
    const o=this.grants.validate(owner,'owner');
    const p=z.strictObject({agentId:AgentId,workId:AgentId,conversationClosed:z.literal(true)}).parse(input);
    const evidence=await engine.evidence(o,p.workId);
    const n=this.store.one<{status:string;epoch:number;attempted_at:number}>('SELECT status,epoch,attempted_at FROM notifications WHERE tenant=? AND work_id=? AND agent=?',o.tenantId,p.workId,p.agentId);
    const a=this.store.one<{epoch:number}>('SELECT epoch FROM agents WHERE tenant=? AND id=?',o.tenantId,p.agentId);
    const claimed=evidence.audit.find(x=>x.type==='claimed'&&x.actor===p.agentId),committed=evidence.audit.find(x=>x.type==='validated_action_and_reply_saved'&&x.actor===p.agentId),done=evidence.audit.find(x=>x.type==='provider_accepted_and_completed');
    if(!a||n?.status!=='accepted'||n.epoch!==a.epoch||evidence.work.status!=='completed'||evidence.work.decisionSource!=='agent'||!claimed||!committed||!done||n.attempted_at>Date.parse(claimed.at)||Date.parse(claimed.at)>Date.parse(committed.at)||Date.parse(committed.at)>Date.parse(done.at))throw new DelegationError('WORKFLOW_NOT_VERIFIED','Require correlated accepted wakeup, agent decision and provider receipt.');
    const profile=this.profile({tenantId:o.tenantId,agentId:p.agentId});
    this.evidence(profile,'background_runs',{status:'verified',method:'engine_workflow',evidenceId:p.workId,scope:'cleaner_reschedule',observedAt:done.at,latencyMs:Date.parse(done.at)-Date.parse(evidence.work.receivedAt),ownerConfirmedConversationClosed:true});this.save(profile);
    return agentReadiness(profile,this.now(),engine.limits.deadlineMs);
  }
  readiness(tenant:string,agent:string,deadlineMs:number){return agentReadiness(this.profile({tenantId:tenant,agentId:agent}),this.now(),deadlineMs);}
}
