import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publicHealth, runtimeHealth } from "../src/install/checks";
import { hostedDemoResetHistoryPath, RESET_HOSTED_DEMO_SUMMARY, RESET_HOSTED_DEMO_WARNING } from "../src/install/hostedDemoReset";
import { hostedInstallationClaimed } from "../src/install/hostedOwner";
import { Installation } from "../src/install/installation";
import { getInstallationStatus } from "../src/install/status";
import { bindHostedTenant, hostedTenantDecision } from "../src/install/tenant";
import { mcpToolList } from "../src/mcp/mcpBridge";
import { hashSecret } from "../src/mcp/oauth/store";
import { setSendblueRuntime, type SendblueClient } from "../src/messaging/sendblue/runtime";
import { MessagingLedger } from "../src/messaging/ledger";
import { ConfirmationBook } from "../src/operator/confirmations";
import { callOperatorTool, OPERATOR_TOOLS, type ToolContext } from "../src/operator/tools";
import { PropertyWorkspace } from "../src/setup";
import { FakeGoogleDrive } from "../src/storage/googleDrive";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { readSendblueEnv } from "../src/messaging/sendblue/runtime";
import { hillsideConfig } from "./liveApp";

const DOMAIN = "demo.up.railway.app";
const BASE = `https://${DOMAIN}`;
const OWNER = "grok-owner-client";
const SB_KEY = "sb-api-key-SECRETVALUE-11111111";
const SB_SECRET = "sb-api-secret-SECRETVALUE-222";
const HOOK_SECRET = "sb-webhook-secret-SECRET-3333";
const ROUTINE_URL = "https://routine.example/hook/SECRETURL";
const ROUTINE_KEY = "routine-bearer-SECRETKEY-1a2b3c4d";
const GOOGLE_REFRESH = "google-refresh-SECRET-token-xyz";
const ACCESS = "old-mcp-access-token-SECRET";
const cleanups: Array<() => void> = [];

afterEach(() => cleanups.splice(0).forEach((run) => run()));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tourcore-reset-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hostedEnv(root: string): NodeJS.ProcessEnv {
  return {
    TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0",
    RAILWAY_PUBLIC_DOMAIN: DOMAIN,
    TOURCORE_HOME: root,
    PORT: "8080",
    TOURCORE_OPERATOR_TOKEN: "distributor-static-token-KEEP",
  };
}

function installation(root: string, env: NodeJS.ProcessEnv, drive?: FakeGoogleDrive, fetches?: string[]) {
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  let inst!: Installation;
  inst = new Installation({
    root,
    runtime,
    env: () => env,
    driveClient: drive,
    fetch: async (url) => {
      fetches?.push(url);
      return { status: 500, json: async () => ({}) };
    },
    sendblueEnv: () => readSendblueEnv(inst.env()),
  });
  return inst;
}

function seed(root: string, inst: Installation) {
  mkdirSync(join(root, "service"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "service", "runtime.json"), JSON.stringify({ keep: true }));
  writeFileSync(join(root, "bin", "keep.txt"), "infrastructure");
  inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0", options: { grokLegacyOAuthCompat: true } });
  inst.files.setPublicBaseUrl(BASE, "RAILWAY");
  const state = inst.files.state();
  inst.files.writeState({
    ...state,
    hostedTenant: { clientId: OWNER, boundAt: "2026-09-01T00:00:00.000Z" },
    visitorMessaging: { ok: true, at: "2026-09-01T00:00:00.000Z", message: "connected", publicBaseUrl: BASE, webhookUrl: `${BASE}/webhooks/sendblue`, problems: [] },
    operatorAlerts: { ok: true, at: "2026-09-01T00:00:00.000Z", message: "connected" },
    operatorUpdates: { schemaVersion: 1, enabled: ["TOUR_BOOKED"], since: {}, updatedAt: "2026-09-01T00:00:00.000Z" },
    portableBackup: {
      destination: { provider: "google_drive", folderName: "Tour Core", configuredAt: "2026-09-01T00:00:00.000Z" },
      lastBackupCreatedAt: "2026-09-02T00:00:00.000Z",
      lastBackupConfirmedInDriveAt: "2026-09-02T00:00:01.000Z",
      lastBackupChecksum: "abc123",
      lastBackupSchemaVersion: 1,
      lastBackupFileName: "tour-core-backup.json",
    },
  });
  inst.secrets.set({
    SENDBLUE_API_API_KEY: SB_KEY,
    SENDBLUE_API_API_SECRET: SB_SECRET,
    SENDBLUE_WEBHOOK_SECRET: HOOK_SECRET,
    SENDBLUE_FROM_NUMBER: "+15555550100",
    TOURCORE_GROK_ROUTINE_URL: ROUTINE_URL,
    TOURCORE_GROK_ROUTINE_KEY: ROUTINE_KEY,
    GOOGLE_OAUTH_REFRESH_TOKEN: GOOGLE_REFRESH,
  });
  inst.secrets.saveHostedOwner({ schemaVersion: 1, claimHash: "spent-claim-hash", claimed: true, ownerId: "own_old", sessionHash: "session-hash", consumedBootstrapHash: "spent-bootstrap-hash" });
  const now = Date.now();
  inst.grants.addGrant({
    clientId: OWNER,
    issuer: BASE,
    resource: `${BASE}/mcp`,
    scopes: ["operator"],
    createdAt: now,
    expiresAt: now + 86_400_000,
    accessHash: hashSecret(ACCESS),
    accessExpiresAt: now + 3_600_000,
    refreshHash: hashSecret("old-refresh-token-SECRET"),
    refreshExpiresAt: now + 86_400_000,
  });
  const ws = new PropertyWorkspace(root);
  ws.save(hillsideConfig());
  const propertyId = hillsideConfig().property.id;
  mkdirSync(join(root, "properties", propertyId, "tours", "tour_old"), { recursive: true });
  writeFileSync(
    join(root, "properties", propertyId, "tours", "tour_old", "tour-export.json"),
    JSON.stringify({ prospects: [{ id: "pros_1", phone: "+15555550199" }], reservations: [{ id: "res_1" }], auditEvents: [{ id: "aud_1" }] }),
  );
  writeFileSync(join(root, "properties", propertyId, "content-changes.json"), JSON.stringify({ schemaVersion: 1, changes: [{ at: "2026-09-01T00:00:00.000Z", changes: ["Unit 1A has 2 bedrooms."] }] }));
  inst.runtime.put("sessions", "visitor_old", { customTimeRequests: [{ id: "ctr_1" }], clarification: "Which unit?" });
  inst.runtime.put("verification", "link_old", { token: "verify-link" });
  inst.runtime.put("endpoints", "line_15555550100", { address: "+15555550100", propertyId });
  inst.runtime.put("operator-events", "evt_old", { eventId: "evt_old", status: "pending" });
  inst.runtime.put("oauth", "extra", { grants: ["not-the-store"] });
  writeFileSync(join(root, "install", "storage-audit.json"), JSON.stringify({ events: ["old"] }));
  mkdirSync(join(root, "portable-handoff"), { recursive: true });
  writeFileSync(join(root, "portable-handoff", "upload.json"), "{}");
  mkdirSync(join(root, "messaging"), { recursive: true });
  writeFileSync(join(root, "messaging", "ledger.json"), JSON.stringify({ old: true }));
  return { propertyId, ws };
}

function context(inst: Installation, caller?: { clientId?: string }, confirmations = new ConfirmationBook()): ToolContext & { ledger: MessagingLedger } {
  const ledger = new MessagingLedger(join(inst.root, "runtime", "messaging-ledger", "ledger.json"));
  ledger.claim("inbound-old");
  const ctx: ToolContext = {
    services: { workspace: new PropertyWorkspace(inst.root) },
    confirmations,
    now: () => new Date(),
    installation: inst,
    ...(caller ? { caller } : {}),
    forgetLiveState: () => ledger.clear(),
  };
  return Object.assign(ctx, { ledger });
}

function useSendblue(options: { fail?: boolean; hooks?: Array<string | { url: string }> } = {}) {
  const deleted: string[][] = [];
  const hooks = options.hooks ?? [{ url: `${BASE}/webhooks/sendblue`, secret: HOOK_SECRET }, { url: "https://other.example/hooks/receive" }];
  const restore = setSendblueRuntime({
    client: () =>
      ({
        webhooks: {
          list: async () => {
            if (options.fail) throw new Error("sendblue down");
            return { webhooks: { receive: hooks } };
          },
          create: async () => ({}),
          delete: async (body: { webhooks: string[] }) => {
            deleted.push(body.webhooks);
            if (options.fail) throw new Error("sendblue down");
            return {};
          },
        },
      }) as unknown as SendblueClient,
  });
  cleanups.push(restore);
  return { deleted };
}

describe("reset_hosted_demo", () => {
  it("is hidden outside the hosted owner, and the first call changes nothing", async () => {
    const root = tempDir();
    const env = hostedEnv(root);
    const inst = installation(root, env);
    const seeded = seed(root, inst);
    const ctx = context(inst, { clientId: OWNER });
    expect(mcpToolList().some((tool) => tool.name === "reset_hosted_demo")).toBe(false);
    expect(mcpToolList(ctx).some((tool) => tool.name === "reset_hosted_demo")).toBe(true);
    expect(mcpToolList(ctx).length).toBe(OPERATOR_TOOLS.length + 1);
    expect(mcpToolList(context(inst)).some((tool) => tool.name === "reset_hosted_demo")).toBe(false);
    expect(mcpToolList(context(inst, { clientId: "someone-else" })).some((tool) => tool.name === "reset_hosted_demo")).toBe(false);

    const local = installation(tempDir(), { TOURCORE_DEPLOYMENT_MODE: "LOCAL_DEVELOPER" });
    local.files.ensure({ deploymentMode: "LOCAL_DEVELOPER" });
    const localCall = await callOperatorTool(context(local, { clientId: OWNER }), "reset_hosted_demo", {});
    expect(localCall.ok).toBe(false);
    if (!localCall.ok) expect(localCall.error).toMatch(/hosted Tour Core service/);

    const anon = await callOperatorTool(context(inst), "reset_hosted_demo", {});
    expect(anon.ok).toBe(false);
    if (!anon.ok) expect(anon.error).toMatch(/current hosted Tour Core owner/);

    const other = await callOperatorTool(context(inst, { clientId: "someone-else" }), "reset_hosted_demo", {});
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error).toMatch(/current hosted Tour Core owner/);

    const extra = await callOperatorTool(ctx, "reset_hosted_demo", { path: "/data" });
    expect(extra.ok).toBe(false);

    const beforeId = inst.files.manifest()!.installationId;
    const asked = await callOperatorTool(ctx, "reset_hosted_demo", {});
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.result.summary).toBe(RESET_HOSTED_DEMO_WARNING);
    expect(asked.result.status).toBe("needs-confirmation");
    expect(inst.files.manifest()!.installationId).toBe(beforeId);
    expect(seeded.ws.list().length).toBe(1);
    expect(inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);
    expect(inst.files.state().hostedTenant?.clientId).toBe(OWNER);
    expect(inst.files.state().portableBackup?.destination?.folderName).toBe("Tour Core");
    expect(inst.grants.findByAccessHash(hashSecret(ACCESS))?.clientId).toBe(OWNER);
  });

  it("refuses a stale or reused confirmation and resets only with the current code", async () => {
    const root = tempDir();
    const env = hostedEnv(root);
    const fetches: string[] = [];
    const drive = new FakeGoogleDrive();
    const folder = await drive.createFolder({ name: "Tour Core", appProperties: { role: "backup" } });
    await drive.createFile({ name: "tour-core-backup.json", parentId: folder.id, content: "{}", appProperties: {} });
    const driveCount = drive.files.size;
    const inst = installation(root, env, drive, fetches);
    const seeded = seed(root, inst);
    const { deleted } = useSendblue();
    const ctx = context(inst, { clientId: OWNER });

    let clock = 1_000_000;
    const expiring = new ConfirmationBook(1_000, () => clock);
    const expiredCtx = context(inst, { clientId: OWNER }, expiring);
    const issued = await callOperatorTool(expiredCtx, "reset_hosted_demo", {});
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const expiredCode = (issued.result.confirmation as { code: string }).code;
    clock += 5_000;
    const staleTime = await callOperatorTool(expiredCtx, "reset_hosted_demo", { confirmationCode: expiredCode });
    expect(staleTime.ok).toBe(false);
    expect(seeded.ws.list().length).toBe(1);

    const asked = await callOperatorTool(ctx, "reset_hosted_demo", {});
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    const code = (asked.result.confirmation as { code: string }).code;
    inst.runtime.put("sessions", "changed_after_ask", { note: "fingerprint must move" });
    const stale = await callOperatorTool(ctx, "reset_hosted_demo", { confirmationCode: code });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toMatch(/changed/);
    const reusedCode = await callOperatorTool(ctx, "reset_hosted_demo", { confirmationCode: code });
    expect(reusedCode.ok).toBe(false);
    if (!reusedCode.ok) expect(reusedCode.error).toMatch(/expired or was already used/);
    expect(inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SB_KEY);

    const again = await callOperatorTool(ctx, "reset_hosted_demo", {});
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const good = (again.result.confirmation as { code: string }).code;
    const done = await callOperatorTool(ctx, "reset_hosted_demo", { confirmationCode: good });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.result.summary).toBe(RESET_HOSTED_DEMO_SUMMARY);
    expect(String(done.result.instructions)).toMatch(/no longer authorized/);
    const reused = await callOperatorTool(ctx, "reset_hosted_demo", { confirmationCode: good });
    expect(reused.ok).toBe(false);

    const text = JSON.stringify(done.result);
    for (const secret of [SB_KEY, SB_SECRET, HOOK_SECRET, ROUTINE_URL, ROUTINE_KEY, GOOGLE_REFRESH, ACCESS]) expect(text).not.toContain(secret);
    const historyPath = hostedDemoResetHistoryPath(root);
    const historyText = readFileSync(historyPath, "utf8");
    for (const secret of [SB_KEY, SB_SECRET, HOOK_SECRET, ROUTINE_URL, ROUTINE_KEY, GOOGLE_REFRESH, ACCESS]) expect(historyText).not.toContain(secret);
    const history = JSON.parse(historyText) as { resets: Array<{ previousInstallationId: string; newInstallationId: string; providerCleanup: { sendblueWebhook: string; googleDriveFiles: string } }> };
    const technical = done.result.technical as { previousInstallationId: string; installationId: string; owner: string; providerCleanup: { sendblueWebhook: string; googleDriveFiles: string; railway: string } };
    expect(technical.owner).toBe("UNCLAIMED");
    expect(technical.previousInstallationId).not.toBe(technical.installationId);
    expect(history.resets[0]?.previousInstallationId).toBe(technical.previousInstallationId);
    expect(history.resets[0]?.newInstallationId).toBe(technical.installationId);
    expect(history.resets[0]?.providerCleanup.sendblueWebhook).toBe("removed");
    expect(deleted).toEqual([[`${BASE}/webhooks/sendblue`]]);
    expect(technical.providerCleanup.googleDriveFiles).toBe("untouched");
    expect(technical.providerCleanup.railway).toBe("preserved");

    expect(new PropertyWorkspace(root).list()).toEqual([]);
    expect(existsSync(join(root, "properties", seeded.propertyId))).toBe(false);
    expect(inst.runtime.list("sessions").entries).toEqual([]);
    expect(inst.runtime.list("operator-events").entries).toEqual([]);
    expect(inst.runtime.list("verification").entries).toEqual([]);
    expect(inst.runtime.list("endpoints").entries).toEqual([]);
    expect(inst.secrets.get("SENDBLUE_API_API_KEY")).toBeUndefined();
    expect(inst.secrets.get("SENDBLUE_FROM_NUMBER")).toBeUndefined();
    expect(inst.secrets.get("TOURCORE_GROK_ROUTINE_URL")).toBeUndefined();
    expect(inst.secrets.get("TOURCORE_GROK_ROUTINE_KEY")).toBeUndefined();
    expect(inst.secrets.get("GOOGLE_OAUTH_REFRESH_TOKEN")).toBeUndefined();
    expect(inst.grants.findByAccessHash(hashSecret(ACCESS))).toBeUndefined();
    expect(inst.grants.connections()).toEqual([]);
    expect(inst.files.state().hostedTenant).toBeUndefined();
    expect(inst.files.state().portableBackup).toBeUndefined();
    expect(inst.files.state().operatorUpdates).toBeUndefined();
    expect(hostedInstallationClaimed(inst)).toBe(false);
    expect(inst.secrets.hostedOwner()?.consumedBootstrapHash).toBe("spent-bootstrap-hash");
    expect(ctx.ledger.entry("inbound-old")).toBeUndefined();

    const manifest = inst.files.manifest()!;
    expect(manifest.installationId).toBe(technical.installationId);
    expect(manifest.deploymentMode).toBe("HOSTED_RAILWAY_P0");
    expect(manifest.publicBaseUrl).toBe(BASE);
    expect(manifest.publicEndpointProvider).toBe("RAILWAY");
    expect(manifest.options?.grokLegacyOAuthCompat).toBe(true);
    expect(env.RAILWAY_PUBLIC_DOMAIN).toBe(DOMAIN);
    expect(env.TOURCORE_OPERATOR_TOKEN).toBe("distributor-static-token-KEEP");
    expect(readFileSync(join(root, "service", "runtime.json"), "utf8")).toContain("keep");
    expect(readFileSync(join(root, "bin", "keep.txt"), "utf8")).toBe("infrastructure");
    expect(existsSync(join(root, "install", "storage-audit.json"))).toBe(false);
    expect(existsSync(join(root, "portable-handoff"))).toBe(false);
    expect(existsSync(join(root, "messaging", "ledger.json"))).toBe(false);
    expect(existsSync(root)).toBe(true);
    expect(drive.files.size).toBe(driveCount);
    expect(drive.files.has(folder.id)).toBe(true);
    expect(fetches).toEqual([]);
    expect(publicHealth(inst)).toMatchObject({ ok: true, service: "tour-core" });
    expect(runtimeHealth(inst).runtimeRecords).toBe("ok");

    const status = getInstallationStatus(inst, { workspace: new PropertyWorkspace(root) });
    expect(status.components.find((item) => item.component === "PROPERTY")?.summary).toMatch(/No property|Set up once/);
    expect(status.components.find((item) => item.component === "VISITOR_MESSAGING")?.summary).toMatch(/isn't connected/);
    expect(status.components.find((item) => item.component === "OPERATOR_ALERTS")?.state).toBe("NOT_CONFIGURED");
    expect(inst.files.state().portableBackup).toBeUndefined();

    expect(hostedTenantDecision(inst.files.state(), "grok-new-client")).toEqual({ allowed: true });
    bindHostedTenant(inst.files, "grok-new-client", new Date());
    expect(inst.files.state().hostedTenant?.clientId).toBe("grok-new-client");
    expect(mcpToolList({ ...ctx, caller: { clientId: OWNER } }).some((tool) => tool.name === "reset_hosted_demo")).toBe(false);

    const restarted = installation(root, env);
    expect(restarted.files.manifest()?.installationId).toBe(technical.installationId);
    expect(restarted.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" }).created).toBe(false);
    expect(restarted.files.manifest()?.installationId).toBe(technical.installationId);
    expect(new PropertyWorkspace(root).list()).toEqual([]);
    expect(restarted.runtime.get("sessions", "visitor_old")).toBeUndefined();
    expect(restarted.secrets.get("SENDBLUE_API_API_KEY")).toBeUndefined();
    expect(restarted.grants.findByAccessHash(hashSecret(ACCESS))).toBeUndefined();
    expect(restarted.files.state().hostedTenant?.clientId).toBe("grok-new-client");
  });

  it("still resets locally when Sendblue cannot remove the webhook, and does not delete unrelated hooks", async () => {
    const root = tempDir();
    const inst = installation(root, hostedEnv(root));
    seed(root, inst);
    const { deleted } = useSendblue({ fail: true });
    const ctx = context(inst, { clientId: OWNER });
    const asked = await callOperatorTool(ctx, "reset_hosted_demo", {});
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    const done = await callOperatorTool(ctx, "reset_hosted_demo", { confirmationCode: (asked.result.confirmation as { code: string }).code });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.result.providerNote).toMatch(/may still have/);
    expect((done.result.technical as { providerCleanup: { sendblueWebhook: string } }).providerCleanup.sendblueWebhook).toBe("may-remain");
    expect(inst.secrets.get("SENDBLUE_API_API_KEY")).toBeUndefined();
    expect(new PropertyWorkspace(root).list()).toEqual([]);
    expect(deleted).toEqual([]);
  });
});
