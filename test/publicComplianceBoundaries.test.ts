import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { smsHelpBody } from "../src/visitor/smsConsent";
import { publicBrandName, publicLegalName } from "../src/web/compliance/config";
import { renderCompliancePage } from "../src/web/compliance/pages";
import { buildComplianceConfig } from "../src/web/compliance/config";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", "tourcore-data", "exports", "coverage", ".git", "runtime", "logs"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".md", ".json", ".html", ".css", ".yml", ".yaml", ".txt", ".toml", ".example"]);

/** Built at runtime so this file does not itself contain the forbidden spellings. */
const OPERATOR = new RegExp(["kha", "nex"].join(""), "i");
const PERSONAL_MAIL = new RegExp(["gm", "ail.com"].join(""), "i");
const SID = /\b(?:AC|SK|MG|PN|BN|QE|BU)[0-9a-fA-F]{32}\b/;

function list(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) list(path, out);
    else if (name === ".env.example" || TEXT_EXT.has(name.slice(name.lastIndexOf(".")))) out.push(path);
  }
  return out;
}

function reservedUs(phone: string): boolean {
  return phone === "+10000000000" || phone.slice(2, 5) === "555";
}

describe("public compliance boundaries", () => {
  it("keeps operator-specific registration data out of the public tree", () => {
    const problems: string[] = [];
    for (const file of list(ROOT)) {
      const rel = relative(ROOT, file).split(sep).join("/");
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, index) => {
          const where = `${rel}:${index + 1}`;
          const negativeAssertion = /not\.to(?:Contain|Match)\(/.test(line);
          if (OPERATOR.test(line) && !negativeAssertion) problems.push(`${where} operator name`);
          if (PERSONAL_MAIL.test(line) && !negativeAssertion) problems.push(`${where} personal email domain`);
          for (const phone of line.match(/\+1\d{10}/g) ?? []) {
            if (!reservedUs(phone)) problems.push(`${where} non-reserved phone`);
          }
          if (SID.test(line)) problems.push(`${where} messaging identifier shape`);
        });
    }
    expect(problems).toEqual([]);
  });

  it("documents provider registration with placeholders only", () => {
    const doc = readFileSync(join(ROOT, "docs/messaging/twilio-a2p-example.md"), "utf8");
    expect(doc).toContain("support@example.com");
    expect(doc).toContain("+15555550123");
    expect(doc).toContain("https://example.com");
    expect(doc).toContain("Example Property Company LLC");
    expect(doc).toContain("does not require Twilio");
    expect(doc).toContain("Prospective renters opt in by texting the configured keyword");
    expect(doc).not.toMatch(OPERATOR);
    expect(doc).not.toMatch(SID);
  });

  it("renders the configured operator and warns in production when it is missing", () => {
    expect(publicLegalName({})).toBeUndefined();
    expect(publicBrandName({})).toBe("Tour Core");
    expect(publicLegalName({ TOURCORE_PUBLIC_LEGAL_NAME: "   " })).toBeUndefined();
    const configured = buildComplianceConfig(
      {
        TOURCORE_PUBLIC_BRAND_NAME: "Example Tours",
        TOURCORE_PUBLIC_LEGAL_NAME: "Example Property Company LLC",
        TOURCORE_PUBLIC_CONTACT_EMAIL: "support@example.com",
        TOURCORE_PUBLIC_SMS_NUMBER: "+15555550123",
      },
      "https://example.com",
    );
    const privacy = renderCompliancePage("privacy", configured);
    expect(privacy).toContain("Example Tours is operated by Example Property Company LLC.");
    expect(privacy).toContain("support@example.com");
    const sms = renderCompliancePage("sms", configured);
    expect(sms).toContain("(555) 555-0123");
    expect(sms).toContain("support@example.com");
    const production = buildComplianceConfig({ NODE_ENV: "production" }, "https://example.com");
    const terms = renderCompliancePage("terms", production);
    expect(terms).toContain("The public legal operator name is not configured.");
    expect(terms).toContain("A public contact email is not configured.");
    expect(terms).not.toMatch(/operated by/i);
    expect(terms).not.toMatch(OPERATOR);
    expect(
      smsHelpBody({
        TOURCORE_PUBLIC_BRAND_NAME: "Example Tours",
        TOURCORE_PUBLIC_CONTACT_EMAIL: "support@example.com",
      }),
    ).toBe("Example Tours: For help with your property tour, email support@example.com. Message and data rates may apply. Reply STOP to opt out.");
    expect(smsHelpBody({ TOURCORE_PUBLIC_BRAND_NAME: "Example Tours" })).toBe(
      "Example Tours: For help with your property tour, reply here. Message and data rates may apply. Reply STOP to opt out.",
    );
    expect(smsHelpBody({ TOURCORE_PUBLIC_BRAND_NAME: "Example Tours" }, { visitorContact: "+15550108888" })).toBe(
      "Example Tours: For help with your property tour, call (555) 010-8888 or reply here. Message and data rates may apply. Reply STOP to opt out.",
    );
    expect(smsHelpBody({ TOURCORE_PUBLIC_BRAND_NAME: "Example Tours" }, { supportEmail: "desk@example.com", visitorContact: "+15550108888" })).toBe(
      "Example Tours: For help with your property tour, email desk@example.com. Message and data rates may apply. Reply STOP to opt out.",
    );
    expect(smsHelpBody({ TOURCORE_PUBLIC_BRAND_NAME: "Example Tours", TOURCORE_PUBLIC_CONTACT_EMAIL: "fallback@example.com" }, { supportEmail: "desk@example.com" })).toBe(
      "Example Tours: For help with your property tour, email desk@example.com. Message and data rates may apply. Reply STOP to opt out.",
    );
    expect(smsHelpBody({ TOURCORE_PUBLIC_BRAND_NAME: "Example Tours" })).not.toMatch(/not configured|TOURCORE_PUBLIC_CONTACT_EMAIL/);
  });
});
