import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DelegationError, type AgentIdentity } from '../prototype';
import { CleanerStore } from './store';
import { AgentId } from '../../agents/profile';

export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export interface GrantIdentity extends AgentIdentity { grantId: string; epoch: number; role: 'owner' | 'agent' }
interface GrantRow { id:string; tenant:string; agent:string; role:GrantIdentity['role']; epoch:number; expires:number; revoked:number }
export class CleanerGrants {
  constructor(readonly store: CleanerStore, readonly now: () => number = Date.now) {}
  /** Local fixture bootstrap only; never an HTTP route. Does not overwrite existing credentials. */
  bootstrap(tenant: string, ownerToken: string) {
    AgentId.parse(tenant); z.string().min(32).parse(ownerToken);
    this.store.tx(() => {
      this.store.run('INSERT OR IGNORE INTO tenants VALUES(?)', tenant);
      if (!this.store.one('SELECT id FROM grants WHERE tenant=? AND role=?', tenant, 'owner'))
        this.issue(tenant, 'owner', 'owner', 1, ownerToken, this.now() + 365 * 86400000);
    });
  }
  /** Trusted test-service bootstrap. A saved revoked/expired token is never resurrected on restart. */
  bootstrapAgent(tenant: string, agent: string, token: string) {
    AgentId.parse(tenant); AgentId.parse(agent); z.string().min(32).parse(token);
    this.store.tx(() => {
      this.store.run('INSERT OR IGNORE INTO agents VALUES(?,?,1,?)', tenant, agent, 'grok');
      const prior = this.store.one<GrantRow>('SELECT * FROM grants WHERE hash=?', digest(token));
      if (prior) {
        if (prior.tenant !== tenant || prior.agent !== agent || prior.role !== 'agent') throw new Error('Test bootstrap credential is already bound elsewhere');
        return;
      }
      const epoch = this.store.one<{epoch:number}>('SELECT epoch FROM agents WHERE tenant=? AND id=?', tenant, agent)!.epoch;
      this.issue(tenant, agent, 'agent', epoch, token);
    });
  }
  private issue(tenant:string, agent:string, role:GrantIdentity['role'], epoch:number, token = secret(), expires = this.now() + 3600000) {
    const id = randomUUID();
    this.store.run('INSERT INTO grants(id,tenant,agent,role,epoch,hash,expires) VALUES(?,?,?,?,?,?,?)', id, tenant, agent, role, epoch, digest(token), expires);
    return { grantId: id, access_token: token, token_type: 'Bearer', expires_in: Math.floor((expires - this.now()) / 1000) };
  }
  resolve(header: string | undefined, role?: GrantIdentity['role']): GrantIdentity {
    if (!header?.startsWith('Bearer ')) throw new DelegationError('UNAUTHORIZED', 'An active grant is required.');
    const row = this.store.one<GrantRow>('SELECT * FROM grants WHERE hash=?', digest(header.slice(7)));
    if (!row) throw new DelegationError('UNAUTHORIZED', 'An active grant is required.');
    const identity: GrantIdentity = { tenantId:row.tenant, agentId:row.agent, grantId:row.id, epoch:row.epoch, role:row.role };
    return this.validate(identity, role);
  }
  validate(identity: AgentIdentity, role?: GrantIdentity['role']): GrantIdentity {
    const i = identity as Partial<GrantIdentity>;
    const row = this.store.one<GrantRow>('SELECT * FROM grants WHERE id=? AND tenant=? AND agent=?', i.grantId ?? '', identity.tenantId, identity.agentId);
    const epoch = row?.role === 'agent' ? this.store.one<{epoch:number}>('SELECT epoch FROM agents WHERE tenant=? AND id=?', identity.tenantId, identity.agentId)?.epoch : row?.epoch;
    if (!row || row.revoked || row.expires <= this.now() || row.epoch !== epoch || (role && row.role !== role)) throw new DelegationError('UNAUTHORIZED', 'The grant is expired, revoked or out of scope.');
    return { tenantId:row.tenant, agentId:row.agent, grantId:row.id, epoch:row.epoch, role:row.role };
  }
  agent(owner: AgentIdentity, input: unknown) {
    const o = this.validate(owner, 'owner');
    const p = z.strictObject({agentId:AgentId, adapterId:z.enum(['grok','generic_mcp']).default('grok')}).parse(input);
    this.store.run('INSERT INTO agents VALUES(?,?,1,?) ON CONFLICT(tenant,id) DO NOTHING', o.tenantId, p.agentId, p.adapterId);
    return { agentId:p.agentId, adapterId:this.store.one<{adapter:string}>('SELECT adapter FROM agents WHERE tenant=? AND id=?', o.tenantId, p.agentId)!.adapter };
  }
  grant(owner: AgentIdentity, input: unknown) {
    const o = this.validate(owner, 'owner');
    const p = z.strictObject({agentId:AgentId}).parse(input);
    const a = this.store.one<{epoch:number}>('SELECT epoch FROM agents WHERE tenant=? AND id=?', o.tenantId, p.agentId);
    if (!a) throw new DelegationError('NOT_FOUND', 'No owned agent.');
    return this.store.tx(() => this.issue(o.tenantId, p.agentId, 'agent', a.epoch));
  }
  revoke(owner: AgentIdentity, grantId: string) {
    const o = this.validate(owner, 'owner');
    return this.store.tx(() => {
      const row = this.store.one<GrantRow>('SELECT * FROM grants WHERE id=? AND tenant=? AND role=?', grantId, o.tenantId, 'agent');
      if (!row) throw new DelegationError('NOT_FOUND', 'No owned agent grant.');
      this.retireAgent(o.tenantId, row.agent);
      return { revoked:true };
    });
  }
  private retireAgent(tenant: string, agent: string) {
      // Credential rotation invalidates evidence AND all live grants/leases for this agent atomically.
      this.store.run('UPDATE agents SET epoch=epoch+1 WHERE tenant=? AND id=?', tenant, agent);
      this.store.run('UPDATE grants SET revoked=1 WHERE tenant=? AND agent=? AND role=?', tenant, agent, 'agent');
      this.store.run('DELETE FROM profiles WHERE tenant=? AND agent=?', tenant, agent);
      this.store.run('DELETE FROM probes WHERE tenant=? AND agent=?', tenant, agent);
      this.store.run("UPDATE notifications SET status='cancelled' WHERE tenant=? AND agent=? AND status IN ('pending','sending')", tenant, agent);
      for (const w of this.store.all<{id:string;data:string}>('SELECT id,data FROM work WHERE tenant=? AND status=?', tenant, 'leased')) {
        const data = JSON.parse(w.data);
        const leaseGrant = this.store.one<{agent:string}>('SELECT agent FROM grants WHERE id=?', data.lease?.owner ?? '');
        if (leaseGrant?.agent !== agent) continue;
        delete data.lease; data.status = 'pending';
        this.store.run('UPDATE work SET status=?,lease_until=NULL,data=? WHERE tenant=? AND id=?', 'pending', JSON.stringify(data), tenant, w.id);
        this.store.run('INSERT INTO audit(tenant,work_id,at,type,actor) VALUES(?,?,?,?,?)', tenant, w.id, new Date(this.now()).toISOString(), 'grant_revoked_lease_released', 'credential_registry');
      }
  }
  register(owner: AgentIdentity, input: unknown) {
    const o = this.validate(owner, 'owner');
    const p = z.strictObject({agentId:AgentId, redirect_uri:z.url()}).parse(input);
    const u = new URL(p.redirect_uri);
    if (u.hash || u.username || u.password || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname)))) throw new DelegationError('INVALID_INPUT', 'Use HTTPS or a loopback redirect.');
    if (!this.store.one('SELECT id FROM agents WHERE tenant=? AND id=?', o.tenantId, p.agentId)) throw new DelegationError('NOT_FOUND', 'No owned agent.');
    const id = randomUUID(); this.store.run('INSERT INTO clients VALUES(?,?,?,?)', id, o.tenantId, p.agentId, p.redirect_uri);
    return {client_id:id, redirect_uri:p.redirect_uri};
  }
  authorize(owner: AgentIdentity, input: unknown) {
    const o = this.validate(owner, 'owner');
    const p = z.strictObject({client_id:z.string(), redirect_uri:z.string(), response_type:z.literal('code'), code_challenge_method:z.literal('S256'), code_challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/), state:z.string().min(1).max(256)}).parse(input);
    const c = this.store.one<{agent:string;redirect:string}>('SELECT * FROM clients WHERE id=? AND tenant=?', p.client_id, o.tenantId);
    if (!c || c.redirect !== p.redirect_uri) throw new DelegationError('NOT_FOUND', 'No owned OAuth client/redirect.');
    const code = secret(), epoch = this.store.one<{epoch:number}>('SELECT epoch FROM agents WHERE tenant=? AND id=?', o.tenantId, c.agent)!.epoch;
    this.store.run('INSERT INTO codes VALUES(?,?,?,?,?)', digest(code), p.client_id, p.code_challenge, this.now() + 60000, epoch);
    return {code, state:p.state, redirect_uri:p.redirect_uri};
  }
  token(input: unknown) {
    const p = z.discriminatedUnion('grant_type', [
      z.strictObject({grant_type:z.literal('authorization_code'),client_id:z.string(),redirect_uri:z.string(),code:z.string(),code_verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/)}),
      z.strictObject({grant_type:z.literal('refresh_token'),client_id:z.string(),refresh_token:z.string()})
    ]).parse(input);
    // Returning an error sentinel commits refresh-reuse revocation rather than rolling it back.
    const result = this.store.tx(() => {
      const c = this.store.one<{tenant:string;agent:string;redirect:string}>('SELECT * FROM clients WHERE id=?', p.client_id);
      if (!c) return undefined;
      const a = this.store.one<{epoch:number}>('SELECT epoch FROM agents WHERE tenant=? AND id=?', c.tenant, c.agent)!;
      if (p.grant_type === 'authorization_code') {
        const code = this.store.one<{challenge:string;expires:number;epoch:number}>('SELECT * FROM codes WHERE hash=? AND client=?', digest(p.code), p.client_id);
        const challenge = createHash('sha256').update(p.code_verifier).digest('base64url');
        if (!code || code.expires <= this.now() || code.epoch !== a.epoch || code.challenge !== challenge || c.redirect !== p.redirect_uri) return undefined;
        this.store.run('DELETE FROM codes WHERE hash=?', digest(p.code));
      } else {
        const r = this.store.one<{grant_id:string;expires:number;used:number}>('SELECT * FROM refresh WHERE hash=? AND client=?', digest(p.refresh_token), p.client_id);
        if (!r) return undefined;
        const g = this.store.one<GrantRow>('SELECT * FROM grants WHERE id=?', r.grant_id);
        if (r.expires <= this.now()) return undefined;
        if (r.used) { if (g?.epoch === a.epoch) this.retireAgent(c.tenant, c.agent); return undefined; }
        if (!g || g.revoked || g.epoch !== a.epoch || r.expires <= this.now()) return undefined;
        this.store.run('UPDATE refresh SET used=1 WHERE hash=?', digest(p.refresh_token));
        this.store.run('UPDATE grants SET revoked=1 WHERE id=?', r.grant_id);
      }
      const grant = this.issue(c.tenant, c.agent, 'agent', a.epoch), refresh = secret();
      this.store.run('INSERT INTO refresh VALUES(?,?,?,?,0)', digest(refresh), grant.grantId, p.client_id, this.now() + 86400000);
      return {...grant, refresh_token:refresh};
    });
    if (!result) throw new DelegationError('UNAUTHORIZED', 'Invalid, expired or reused OAuth grant.');
    return result;
  }
}
