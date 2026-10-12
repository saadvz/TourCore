import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/** Synchronous short transactions only: never await while a transaction is open. */
export class CleanerStore {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(version INTEGER NOT NULL);
      INSERT INTO metadata SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM metadata);
      CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS agents(tenant TEXT NOT NULL REFERENCES tenants(id), id TEXT NOT NULL, epoch INTEGER NOT NULL, adapter TEXT NOT NULL, PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id), agent TEXT NOT NULL, role TEXT NOT NULL, epoch INTEGER NOT NULL, hash TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS grants_identity ON grants(tenant,agent,revoked);
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id), agent TEXT NOT NULL, redirect TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY, client TEXT NOT NULL REFERENCES clients(id), challenge TEXT NOT NULL, expires INTEGER NOT NULL, epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS refresh(hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id), client TEXT NOT NULL REFERENCES clients(id), expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS turns(tenant TEXT NOT NULL REFERENCES tenants(id), id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id), account TEXT NOT NULL, number TEXT NOT NULL, recipient TEXT NOT NULL, guarantee TEXT NOT NULL, credential_epoch TEXT NOT NULL, UNIQUE(account,number), UNIQUE(tenant,id));
      CREATE TABLE IF NOT EXISTS properties(tenant TEXT NOT NULL REFERENCES tenants(id), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS access_records(tenant TEXT NOT NULL, id TEXT NOT NULL, property TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant,id), FOREIGN KEY(tenant,property) REFERENCES properties(tenant,id));
      CREATE TABLE IF NOT EXISTS work(tenant TEXT NOT NULL, id TEXT NOT NULL, binding TEXT NOT NULL REFERENCES bindings(id), source TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, deadline INTEGER NOT NULL, lease_until INTEGER, data TEXT NOT NULL, PRIMARY KEY(tenant,id), UNIQUE(tenant,binding,source), FOREIGN KEY(tenant,turn_id) REFERENCES turns(tenant,id), FOREIGN KEY(tenant,binding) REFERENCES bindings(tenant,id));
      CREATE INDEX IF NOT EXISTS work_entity ON work(tenant,turn_id,status);
      CREATE INDEX IF NOT EXISTS work_open ON work(tenant,status,deadline);
      CREATE INDEX IF NOT EXISTS work_deadlines ON work(status,deadline);
      CREATE INDEX IF NOT EXISTS work_leases ON work(status,lease_until);
      CREATE TABLE IF NOT EXISTS actions(tenant TEXT NOT NULL, key TEXT NOT NULL, work_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(tenant,key), FOREIGN KEY(tenant,work_id) REFERENCES work(tenant,id));
      CREATE TABLE IF NOT EXISTS outbox(tenant TEXT NOT NULL, work_id TEXT NOT NULL, binding TEXT NOT NULL REFERENCES bindings(id), status TEXT NOT NULL, due INTEGER NOT NULL, attempt_token TEXT, lease_until INTEGER, data TEXT NOT NULL, PRIMARY KEY(tenant,work_id), FOREIGN KEY(tenant,work_id) REFERENCES work(tenant,id), FOREIGN KEY(tenant,binding) REFERENCES bindings(tenant,id));
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(tenant,status,due);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY, tenant TEXT NOT NULL, work_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, FOREIGN KEY(tenant,work_id) REFERENCES work(tenant,id));
      CREATE INDEX IF NOT EXISTS audit_work ON audit(tenant,work_id,seq);
      CREATE TABLE IF NOT EXISTS notifications(tenant TEXT NOT NULL, work_id TEXT NOT NULL, agent TEXT NOT NULL, epoch INTEGER NOT NULL, status TEXT NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, token TEXT, lease_until INTEGER, http INTEGER, attempted_at INTEGER, accepted_at INTEGER, onboarding INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(tenant,work_id,agent), FOREIGN KEY(tenant,work_id) REFERENCES work(tenant,id));
      CREATE INDEX IF NOT EXISTS notifications_due ON notifications(tenant,status,due);
      CREATE TABLE IF NOT EXISTS delivery_events(seq INTEGER PRIMARY KEY, tenant TEXT NOT NULL, work_id TEXT NOT NULL, binding TEXT NOT NULL, source TEXT NOT NULL, receipt TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(tenant,binding,source), FOREIGN KEY(tenant,work_id) REFERENCES work(tenant,id), FOREIGN KEY(tenant,binding) REFERENCES bindings(tenant,id));
      CREATE INDEX IF NOT EXISTS delivery_events_work ON delivery_events(tenant,work_id,seq);
      CREATE TABLE IF NOT EXISTS profiles(tenant TEXT NOT NULL, agent TEXT NOT NULL, epoch INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant,agent), FOREIGN KEY(tenant,agent) REFERENCES agents(tenant,id));
      CREATE TABLE IF NOT EXISTS probes(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, agent TEXT NOT NULL, epoch INTEGER NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL, FOREIGN KEY(tenant,agent) REFERENCES agents(tenant,id));
      CREATE TABLE IF NOT EXISTS budgets(tenant TEXT NOT NULL REFERENCES tenants(id), kind TEXT NOT NULL, window INTEGER NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(tenant,kind));
    `);
    if (this.one<{version:number}>('SELECT version FROM metadata')?.version !== 1) throw new Error('Unsupported Cleaner schema');
    if (this.one<Record<string,string>>('PRAGMA quick_check')?.quick_check !== 'ok') throw new Error('Damaged Cleaner storage');
  }
  run(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).run(...params); }
  one<T>(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).get(...params) as T | undefined; }
  all<T>(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).all(...params) as T[]; }
  tx<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  consume(tenant: string, kind: string, now: number, maximum: number, period = 1000): boolean {
    const window = Math.floor(now / period);
    const result = this.run(`INSERT INTO budgets VALUES(?,?,?,1) ON CONFLICT(tenant,kind)
      DO UPDATE SET used=CASE WHEN budgets.window=excluded.window THEN budgets.used+1 ELSE 1 END,
      window=excluded.window WHERE budgets.window<>excluded.window OR budgets.used<?`, tenant, kind, window, maximum);
    return Number(result.changes) > 0;
  }
  close() { this.db.close(); }
}
