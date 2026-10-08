import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { MCP_PATH } from "../src/mcp/paths";
import { SENDBLUE_WEBHOOK_PATH } from "../src/messaging/sendblue/runtime";
import { buildComplianceConfig, formatPublicSmsNumber } from "../src/web/compliance/config";
import { MESSAGE_RATES, PRIVACY_NON_SHARING } from "../src/web/compliance/pages";
import { PropertyWorkspace } from "../src/setup";
import { createSetupServer } from "../src/web/server";

const PUBLIC_HOST = "compliance.example";
const PUBLIC_BASE = `https://${PUBLIC_HOST}`;
const CAMPAIGN_NUMBER = "+15555550123";
const CAMPAIGN_DISPLAY = "(555) 555-0123";
const BRAND = "Example Tours";
const LEGAL = "Example Property Company LLC";
const SENDBLUE_LINE = "+15550001111";
const SECRET = "sb-api-key-SHOULD-NOT-RENDER-9f3a";
const TOKEN = "operator-token-SHOULD-NOT-RENDER-9f3a";
const WEBHOOK_SECRET = "webhook-secret-SHOULD-NOT-RENDER-9f3a";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function startApp() {
  const root = mkdtempSync(join(tmpdir(), "tourcore-compliance-"));
  const server: Server = createSetupServer({
    toolSurface: "all", workspace: new PropertyWorkspace(root), log: () => {} });
  return new Promise<{ port: number; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const close = () => {
        server.close();
        rmSync(root, { recursive: true, force: true });
      };
      cleanup.push(close);
      resolve({ port, close });
    });
  });
}

function http(port: number, path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; location: string | undefined; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  cleanup.push(restore);
  return run().finally(restore);
}

describe("public SMS number formatting", () => {
  it("formats a U.S. number without changing the canonical value", () => {
    expect(formatPublicSmsNumber(CAMPAIGN_NUMBER)).toBe(CAMPAIGN_DISPLAY);
    expect(formatPublicSmsNumber("+442079460958")).toBe("+442079460958");
    const env = { TOURCORE_PUBLIC_SMS_NUMBER: CAMPAIGN_NUMBER };
    const config = buildComplianceConfig(env, PUBLIC_BASE);
    expect(config.brandName).toBe("Tour Core");
    expect(config.legalName).toBeUndefined();
    expect(config.legalNameProblem).toBe("missing");
    expect(config.smsNumber).toEqual({ canonical: CAMPAIGN_NUMBER, display: CAMPAIGN_DISPLAY });
    expect(env.TOURCORE_PUBLIC_SMS_NUMBER).toBe(CAMPAIGN_NUMBER);
    expect(config.privacyUrl).toBe(`${PUBLIC_BASE}/TourCore/privacy`);
    expect(config.termsUrl).toBe(`${PUBLIC_BASE}/TourCore/terms`);
    expect(config.smsUrl).toBe(`${PUBLIC_BASE}/TourCore/sms`);
  });
});

describe("public compliance pages", () => {
  it("serves privacy, terms, and SMS without a session", async () => {
    const { port } = await startApp();
    await withEnv(
      {
        PUBLIC_BASE_URL: PUBLIC_BASE,
        TOURCORE_PUBLIC_BRAND_NAME: BRAND,
        TOURCORE_PUBLIC_LEGAL_NAME: LEGAL,
        TOURCORE_PUBLIC_SMS_NUMBER: CAMPAIGN_NUMBER,
        TOURCORE_PUBLIC_CONTACT_EMAIL: "privacy@example.com",
        SENDBLUE_FROM_NUMBER: SENDBLUE_LINE,
        SENDBLUE_API_API_KEY: SECRET,
        SENDBLUE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        TOURCORE_OPERATOR_TOKEN: TOKEN,
      },
      async () => {
        for (const path of ["/TourCore/privacy", "/TourCore/terms", "/TourCore/sms"] as const) {
          const page = await http(port, path);
          expect(page.status, path).toBe(200);
          expect(page.text).toContain(BRAND);
          expect(page.text).toContain(LEGAL);
          expect(page.text).not.toMatch(/khanex/i);
          expect(page.text).not.toContain("Tour Core LLC");
          expect(page.text).not.toContain(SECRET);
          expect(page.text).not.toContain(TOKEN);
          expect(page.text).not.toContain(WEBHOOK_SECRET);
          expect(page.text).not.toContain(SENDBLUE_LINE);
          expect(page.text).not.toMatch(/railway\.app/i);
        }

        const privacy = await http(port, "/TourCore/privacy");
        expect(privacy.text).toContain("Privacy Policy");
        expect(privacy.text).toContain(PRIVACY_NON_SHARING);
        expect(privacy.text).toContain("privacy@example.com");
        expect(privacy.text).toContain(`${BRAND} is operated by ${LEGAL}.`);
        expect(privacy.text).toContain("Reply STOP");
        expect(privacy.text).toContain("Reply HELP");

        const terms = await http(port, "/TourCore/terms");
        expect(terms.text).toContain("Terms & Conditions");
        expect(terms.text).toContain("SMS Terms");
        expect(terms.text).toContain("Carriers are not liable for any delayed or undelivered messages.");
        expect(terms.text).toContain(MESSAGE_RATES);
        expect(terms.text).toContain("STOP");
        expect(terms.text).toContain("HELP");
        expect(terms.text).toContain("privacy@example.com");
        expect(terms.text).toContain(`${BRAND} is operated by ${LEGAL}.`);
        expect(terms.text).toContain(`${LEGAL}, operating ${BRAND}`);
        expect(terms.text).toContain('href="/TourCore/privacy"');
        expect(terms.text).toContain('href="/TourCore/sms"');

        const sms = await http(port, "/TourCore/sms");
        expect(sms.text).toContain(`${BRAND} SMS`);
        expect(sms.text).toContain("TOUR");
        expect(sms.text).toContain(CAMPAIGN_DISPLAY);
        expect(sms.text).toContain(`data-sms-number="${CAMPAIGN_NUMBER}"`);
        expect(sms.text).toContain("YES");
        expect(sms.text).toContain("STOP");
        expect(sms.text).toContain("HELP");
        expect(sms.text).toContain("privacy@example.com");
        expect(sms.text).toContain(`${BRAND} is operated by ${LEGAL}.`);
        expect(sms.text).toContain(`${BRAND}: You&#39;re starting a text conversation`);
        expect(sms.text).not.toMatch(/khanex/i);
        expect(sms.text).toContain("Message frequency varies");
        expect(sms.text).toContain(MESSAGE_RATES);
        expect(sms.text).toContain('href="/TourCore/privacy"');
        expect(sms.text).toContain('href="/TourCore/terms"');
        expect(sms.text).toContain(`${PUBLIC_BASE}/TourCore/privacy`);
        expect(sms.text).toContain(`${PUBLIC_BASE}/TourCore/terms`);
        expect(sms.text).toContain(`Text TOUR to ${CAMPAIGN_DISPLAY} to ask questions or schedule a self-guided tour.`);
      },
    );
  });

  it("redirects lowercase paths to the capitalized routes", async () => {
    const { port } = await startApp();
    const privacy = await http(port, "/tourcore/privacy");
    expect(privacy.status).toBe(301);
    expect(privacy.location).toBe("/TourCore/privacy");
    const sms = await http(port, "/TourCore/sms/");
    expect(sms.status).toBe(301);
    expect(sms.location).toBe("/TourCore/sms");
  });

  it("is reachable on the configured public host and hidden from any other host", async () => {
    const { port } = await startApp();
    await withEnv({ PUBLIC_BASE_URL: PUBLIC_BASE, TOURCORE_PUBLIC_SMS_NUMBER: CAMPAIGN_NUMBER }, async () => {
      const published = await http(port, "/TourCore/sms", { host: PUBLIC_HOST });
      expect(published.status).toBe(200);
      expect(published.text).toContain(CAMPAIGN_DISPLAY);
      const stranger = await http(port, "/TourCore/privacy", { host: "evil.example" });
      expect(stranger.status).toBe(403);
      const install = await http(port, "/install", { host: "evil.example" });
      expect(install.status).toBe(403);
      const publicInstall = await http(port, "/install", { host: PUBLIC_HOST });
      expect(publicInstall.status).toBe(404);
    });
  });

  it("warns in development and does not invent a number or email when they are missing", async () => {
    const { port } = await startApp();
    await withEnv(
      {
        PUBLIC_BASE_URL: undefined,
        TOURCORE_PUBLIC_BRAND_NAME: undefined,
        TOURCORE_PUBLIC_LEGAL_NAME: undefined,
        TOURCORE_PUBLIC_SMS_NUMBER: undefined,
        TOURCORE_PUBLIC_CONTACT_EMAIL: undefined,
        SENDBLUE_FROM_NUMBER: SENDBLUE_LINE,
        NODE_ENV: "test",
        TOURCORE_DEPLOYMENT_MODE: undefined,
      },
      async () => {
        const sms = await http(port, "/TourCore/sms");
        expect(sms.status).toBe(200);
        expect(sms.text).toContain("TOURCORE_PUBLIC_SMS_NUMBER");
        expect(sms.text).toContain("TOURCORE_PUBLIC_LEGAL_NAME");
        expect(sms.text).toContain("will not invent a legal entity");
        expect(sms.text).not.toMatch(/operated by/i);
        expect(sms.text).toContain("[TOUR CORE NUMBER]");
        expect(sms.text).toContain("PUBLIC_BASE_URL");
        expect(sms.text).not.toContain(CAMPAIGN_DISPLAY);
        expect(sms.text).not.toContain(SENDBLUE_LINE);
        expect(sms.text).not.toMatch(/railway\.app/i);
        const privacy = await http(port, "/TourCore/privacy");
        expect(privacy.text).toContain("TOURCORE_PUBLIC_CONTACT_EMAIL");
        expect(privacy.text).toContain("TOURCORE_PUBLIC_LEGAL_NAME");
        expect(privacy.text).not.toMatch(/operated by/i);
        expect(privacy.text).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      },
    );
  });

  it("does not publish a placeholder number or a fake email outside local development", async () => {
    const { port } = await startApp();
    await withEnv(
      {
        NODE_ENV: "production",
        PUBLIC_BASE_URL: PUBLIC_BASE,
        TOURCORE_PUBLIC_BRAND_NAME: undefined,
        TOURCORE_PUBLIC_LEGAL_NAME: undefined,
        TOURCORE_PUBLIC_SMS_NUMBER: undefined,
        TOURCORE_PUBLIC_CONTACT_EMAIL: undefined,
        SENDBLUE_FROM_NUMBER: SENDBLUE_LINE,
      },
      async () => {
        const sms = await http(port, "/TourCore/sms");
        expect(sms.text).toContain("The public Tour Core phone number is not configured.");
        expect(sms.text).not.toContain("[TOUR CORE NUMBER]");
        expect(sms.text).not.toContain("TOURCORE_PUBLIC_SMS_NUMBER");
        expect(sms.text).not.toContain(CAMPAIGN_DISPLAY);
        expect(sms.text).not.toContain(SENDBLUE_LINE);
        const privacy = await http(port, "/TourCore/privacy");
        expect(privacy.text).toContain("A public contact email is not configured.");
        expect(privacy.text).toContain("The public legal operator name is not configured.");
        expect(privacy.text).not.toContain("TOURCORE_PUBLIC_CONTACT_EMAIL");
        expect(privacy.text).not.toContain("TOURCORE_PUBLIC_LEGAL_NAME");
        expect(privacy.text).not.toMatch(/operated by/i);
        expect(privacy.text).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      },
    );
  });

  it("leaves health, MCP, and the Sendblue webhook in place", async () => {
    const { port } = await startApp();
    const health = await http(port, "/healthz");
    expect(health.status).toBe(200);
    expect(health.text).toContain("tour-core");
    const mcp = await http(port, MCP_PATH, { "content-type": "application/json" }, "POST");
    expect(mcp.status).not.toBe(404);
    const webhook = await http(port, SENDBLUE_WEBHOOK_PATH, { "content-type": "application/json" }, "POST");
    expect(webhook.status).not.toBe(404);
    expect([400, 401]).toContain(webhook.status);
  });
});

describe("compliance sources", () => {
  it("does not hardcode a hosting provider or a phone number", () => {
    const dir = fileURLToPath(new URL("../src/web/compliance/", import.meta.url));
    const source = ["config.ts", "pages.ts"].map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
    expect(source).not.toMatch(/railway\.app/i);
    expect(source).not.toMatch(/\+1\d{10}/);
    expect(source).not.toContain(SENDBLUE_LINE);
    expect(source).toContain("PUBLIC_BASE_URL");
    expect(source).toContain("TOURCORE_PUBLIC_SMS_NUMBER");
    expect(source).toContain("TOURCORE_PUBLIC_LEGAL_NAME");
    expect(source).toContain("TOURCORE_PUBLIC_BRAND_NAME");
    expect(source).not.toMatch(/khanex/i);
  });
});
