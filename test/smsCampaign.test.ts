import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { zonedTimeToUtc } from "../src/core/timezone";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { createSetupServer } from "../src/web/server";
import { fakeSendblue, inbound, PUBLIC, SECRET, sendblueEnv } from "./fakeSendblue";

const at = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York").getTime();
const PHONE = "+15550102000";
let handle = 0;

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function sendblueProperty(): TourCoreConfig {
  const config = loadConfig();
  return { ...config, messagingMode: "live", property: { ...config.property, facts: ["Street parking only."] } };
}

async function startPhoneApp(root?: string, operator: { visitorContact?: string } = {}) {
  const dir = root ?? mkdtempSync(join(tmpdir(), "tourcore-sms-"));
  const fake = fakeSendblue();
  cleanups.push(setSendblueRuntime({ env: () => sendblueEnv(), client: () => fake.client }));
  const clock = at(7);
  const ws = new PropertyWorkspace(dir);
  if (!ws.list().length) {
    const base = sendblueProperty();
    const { config } = ws.save({
      ...base,
      operator: { ...base.operator, ...operator, ...(operator.visitorContact ? { visitorHelpDecided: true } : {}) },
    });
    ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(clock) }));
  }
  const server: Server = createSetupServer({
    toolSurface: "all", workspace: ws, now: () => new Date(clock), realNow: () => clock, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const text = async (content: string, from = PHONE) => {
    const before = fake.sent.length;
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/sendblue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "sb-signing-secret": SECRET },
      body: JSON.stringify(inbound(from, content, `sms_${++handle}`)),
    });
    return { status: res.status, replies: fake.sent.slice(before).filter((s) => s.number === from).map((s) => s.content) };
  };
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  cleanups.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ws, text, close, root: dir, id: ws.list()[0]!.config.property.id };
}

describe("SMS keyword campaign", () => {
  it("sends only the disclosure for TOUR, then the property flow after YES", async () => {
    const app = await startPhoneApp();
    const tour = await app.text("TOUR");
    expect(tour.replies).toHaveLength(1);
    expect(tour.replies[0]).toContain("Tour Core: You're starting a text conversation about a self-guided property tour.");
    expect(tour.replies[0]).not.toContain("Khanex");
    expect(tour.replies[0]).toContain("Message frequency varies. Message and data rates may apply.");
    expect(tour.replies[0]).toContain("Reply YES to continue, HELP for help, or STOP to opt out.");
    expect(tour.replies[0]).toContain(`${PUBLIC}/TourCore/privacy`);
    expect(tour.replies[0]).toContain(`${PUBLIC}/TourCore/terms`);
    expect(tour.replies[0]).not.toContain("Which unit");
    expect(tour.replies[0]).not.toContain("Street parking");
    expect(tour.replies[0]).not.toMatch(/trycloudflare|railway\.app/i);

    const parked = await app.text("Is there parking?");
    expect(parked.replies.join("\n")).toBe("Reply YES to continue, HELP for help, or STOP to opt out.");
    expect(parked.replies.join("\n")).not.toContain("Street parking");
    expect(parked.replies.join("\n")).not.toContain("Which unit");

    const yes = await app.text("YES");
    expect(yes.replies[0]).toContain(
      "You're opted in. I can answer questions about the property and help you schedule and complete a self-guided tour.\nI'll keep a record of your visit times and the doors you use.\n\nReply STOP at any time to opt out.",
    );
    expect(yes.replies.join("\n")).toContain("Which unit would you like to see?");

    const file = JSON.parse(readFileSync(join(app.root, "properties", app.id, "sms-campaign-consent.json"), "utf8"));
    expect(file.senders[PHONE]).toMatchObject({ sender: PHONE, status: "opted_in", method: "keyword", keyword: "YES" });
    expect(file.senders[PHONE].optedInAt).toBeTruthy();
    expect(JSON.stringify(file)).not.toContain("Street parking");
    expect(JSON.stringify(file)).not.toContain("Which unit");
  });

  it("HELP lists the visitor help number when set, then reply here — never email, env-var, or not-configured wording", async () => {
    const previous = process.env.TOURCORE_PUBLIC_CONTACT_EMAIL;
    process.env.TOURCORE_PUBLIC_CONTACT_EMAIL = "desk@example.com";
    try {
      const numbered = await startPhoneApp(undefined, { visitorContact: "+15550108888" });
      expect((await numbered.text("HELP")).replies.join("\n")).toBe(
        "Tour Core: For help with your property tour, call (555) 010-8888 or reply here. Message and data rates may apply. Reply STOP to opt out.",
      );
      expect((await numbered.text("HELP")).replies.join("\n")).not.toMatch(/email|not configured|TOURCORE_PUBLIC_CONTACT_EMAIL/);
      await numbered.close();

      const neither = await startPhoneApp();
      const body = (await neither.text("HELP")).replies.join("\n");
      expect(body).toBe("Tour Core: For help with your property tour, reply here. Message and data rates may apply. Reply STOP to opt out.");
      expect(body).not.toMatch(/email|not configured|TOURCORE_PUBLIC_CONTACT_EMAIL/);
    } finally {
      if (previous === undefined) delete process.env.TOURCORE_PUBLIC_CONTACT_EMAIL;
      else process.env.TOURCORE_PUBLIC_CONTACT_EMAIL = previous;
    }
  });

  it("HELP names Tour Core and does not use the contact-email env, and STOP blocks ordinary messages until START and YES", async () => {
    const previous = process.env.TOURCORE_PUBLIC_CONTACT_EMAIL;
    process.env.TOURCORE_PUBLIC_CONTACT_EMAIL = "help@example.com";
    try {
    const app = await startPhoneApp();
    const help = await app.text("HELP");
    expect(help.replies).toHaveLength(1);
    expect(help.replies.join("\n")).toBe("Tour Core: For help with your property tour, reply here. Message and data rates may apply. Reply STOP to opt out.");
    expect(help.replies.join("\n")).not.toContain("Khanex");
    expect(help.replies.join("\n")).not.toContain("Which unit");

    await app.text("TOUR");
    await app.text("YES");
    const stop = await app.text("STOP");
    expect(stop.replies.join("\n")).toContain("You're opted out");
    expect((await app.text("Which unit?")).replies).toEqual([]);
    expect((await app.text("Is there parking?")).replies).toEqual([]);

    const start = await app.text("START");
    expect(start.replies.join("\n")).toContain("Reply YES to continue");
    expect(start.replies.join("\n")).not.toContain("Which unit");
    expect((await app.text("1")).replies.join("\n")).not.toContain("Which day");
    const yes = await app.text("YES");
    expect(yes.replies.join("\n")).toContain("You're opted in");
    expect(yes.replies.join("\n")).toContain("Which unit would you like to see?");
    } finally {
      if (previous === undefined) delete process.env.TOURCORE_PUBLIC_CONTACT_EMAIL;
      else process.env.TOURCORE_PUBLIC_CONTACT_EMAIL = previous;
    }
  });

  it("keeps YES across a restart and still waits when YES has not arrived", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-sms-restart-"));
    const first = await startPhoneApp(root);
    await first.text("TOUR");
    await first.close();

    const waiting = await startPhoneApp(root);
    const parked = await waiting.text("Is there parking?");
    expect(parked.replies.join("\n")).not.toContain("Street parking");
    expect(parked.replies.join("\n")).not.toContain("Which unit");
    expect(parked.replies.join("\n")).toContain("Reply YES");
    await waiting.close();

    const enrolled = await startPhoneApp(root);
    const yes = await enrolled.text("YES");
    expect(yes.replies.join("\n")).toContain("You're opted in");
    expect(yes.replies.join("\n")).toContain("Which unit");
    await enrolled.text("1");
    await enrolled.close();

    const resumed = await startPhoneApp(root);
    const day = await resumed.text("1");
    expect(day.replies.join("\n")).toContain("I have these times available");
    expect(day.replies.join("\n")).not.toContain("Reply YES to continue");
  });

  it("does not treat another sender's phone number or an older tour as consent", async () => {
    const app = await startPhoneApp();
    await app.text("TOUR");
    await app.text("YES");
    const other = await app.text("Hi", "+15550108888");
    expect(other.replies.join("\n")).toContain("Text TOUR");
    expect(other.replies.join("\n")).not.toContain("Which unit");
  });
});
