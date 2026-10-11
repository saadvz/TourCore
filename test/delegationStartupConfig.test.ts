import { describe, expect, it } from "vitest";
import { DelegationStartupError, resolveTestStartupConfig } from "../src/delegation/startupConfig";

const railway = { CLEANER_TEST_HOST: "0.0.0.0", RAILWAY_PUBLIC_DOMAIN: "cleaner.example", PORT: "8080", CLEANER_TEST_AGENT_TOKEN: "a".repeat(32), CLEANER_TEST_ADMIN_TOKEN: "b".repeat(32) };

describe("Cleaner Core deployment configuration", () => {
  const sms = { CLEANER_TEST_SMS_ENABLED: "true", CLEANER_TEST_TWILIO_ACCOUNT_SID: `AC${"c".repeat(32)}`,
    CLEANER_TEST_TWILIO_AUTH_TOKEN: "private_twilio_token".repeat(3), CLEANER_TEST_TWILIO_FROM_NUMBER: "+12025550100", CLEANER_TEST_SMS_TEST_NUMBER: "+12025550101",
    CLEANER_TEST_WEBHOOK_URL: "https://hooks.example/private", CLEANER_TEST_WEBHOOK_AUTH: "Bearer private_webhook_value" };
  it("keeps SMS disabled by default and enables only a complete dedicated phone pair with canonical HTTPS origin", () => {
    expect(resolveTestStartupConfig(railway).sms).toBeUndefined();
    expect(resolveTestStartupConfig({ ...railway, ...sms, CLEANER_TEST_SMS_ENABLED: "false" }).sms).toBeUndefined();
    expect(resolveTestStartupConfig({ ...railway, ...sms, CLEANER_TEST_PUBLIC_URL: "https://cleaner.example/" }).sms).toEqual({
      accountSid: sms.CLEANER_TEST_TWILIO_ACCOUNT_SID, authToken: sms.CLEANER_TEST_TWILIO_AUTH_TOKEN,
      fromNumber: sms.CLEANER_TEST_TWILIO_FROM_NUMBER, testNumber: sms.CLEANER_TEST_SMS_TEST_NUMBER, publicBaseUrl: "https://cleaner.example" });
  });
  it("refuses incomplete SMS settings and invalid opt-in values without printing credentials or phone numbers", () => {
    const invalid = [
      ...["CLEANER_TEST_TWILIO_ACCOUNT_SID", "CLEANER_TEST_TWILIO_AUTH_TOKEN", "CLEANER_TEST_TWILIO_FROM_NUMBER", "CLEANER_TEST_SMS_TEST_NUMBER", "CLEANER_TEST_WEBHOOK_URL", "CLEANER_TEST_WEBHOOK_AUTH"].map((name) => ({ [name]: undefined })),
      { CLEANER_TEST_SMS_ENABLED: "yes" }, { CLEANER_TEST_TWILIO_ACCOUNT_SID: "private_wrong_sid" },
      { CLEANER_TEST_TWILIO_AUTH_TOKEN: " private_twilio_token".repeat(3) },
      { CLEANER_TEST_TWILIO_FROM_NUMBER: "12025550100" },
      { CLEANER_TEST_SMS_TEST_NUMBER: sms.CLEANER_TEST_TWILIO_FROM_NUMBER },
    ];
    for (const change of invalid) {
      try { resolveTestStartupConfig({ ...railway, ...sms, ...change }); throw new Error("Expected validation failure"); }
      catch (error) {
        expect(error).toBeInstanceOf(DelegationStartupError);
        for (const value of [sms.CLEANER_TEST_TWILIO_ACCOUNT_SID, sms.CLEANER_TEST_TWILIO_AUTH_TOKEN, sms.CLEANER_TEST_TWILIO_FROM_NUMBER, sms.CLEANER_TEST_SMS_TEST_NUMBER, "private_wrong_sid"]) expect((error as Error).message).not.toContain(value);
      }
    }
    expect(() => resolveTestStartupConfig({ ...sms })).toThrow("HTTPS public origin");
  });
  it("accepts paired webhook settings and rejects invalid or incomplete settings without disclosing them", () => {
    const valid = { CLEANER_TEST_WEBHOOK_URL: "https://hooks.example/private", CLEANER_TEST_WEBHOOK_AUTH: "Bearer private_webhook_value" };
    expect(resolveTestStartupConfig({ ...railway, ...valid }).webhook).toEqual({ url: valid.CLEANER_TEST_WEBHOOK_URL, authorization: valid.CLEANER_TEST_WEBHOOK_AUTH });
    for (const settings of [
      { ...valid, CLEANER_TEST_WEBHOOK_URL: undefined },
      { ...valid, CLEANER_TEST_WEBHOOK_AUTH: undefined },
      { ...valid, CLEANER_TEST_WEBHOOK_AUTH: "Bearer private\nvalue" },
      { ...valid, CLEANER_TEST_WEBHOOK_URL: "http://hooks.example/private" },
      { ...valid, CLEANER_TEST_WEBHOOK_URL: "https://user:private@hooks.example/private" },
      { ...valid, CLEANER_TEST_WEBHOOK_URL: "not_a_url" },
    ]) {
      try { resolveTestStartupConfig({ ...railway, ...settings }); throw new Error("Expected validation failure"); }
      catch (error) {
        expect(error).toBeInstanceOf(DelegationStartupError);
        expect((error as Error).message).not.toContain("private");
        if (settings.CLEANER_TEST_WEBHOOK_URL) expect((error as Error).message).not.toContain(settings.CLEANER_TEST_WEBHOOK_URL);
      }
    }
  });
  it("accepts Railway port/domain with distinct valid credentials and leaves local automatic credentials available", () => {
    expect(resolveTestStartupConfig(railway)).toMatchObject({ port: 8080, host: "0.0.0.0", publicBaseUrl: "https://cleaner.example" });
    expect(resolveTestStartupConfig({})).toMatchObject({ port: 4332, host: "127.0.0.1", credentials: undefined });
  });

  it("names missing, short, and identical credentials without revealing values", () => {
    const inputs = [
      { env: { ...railway, CLEANER_TEST_AGENT_TOKEN: undefined }, message: "CLEANER_TEST_AGENT_TOKEN is missing" },
      { env: { ...railway, CLEANER_TEST_ADMIN_TOKEN: undefined }, message: "CLEANER_TEST_ADMIN_TOKEN is missing" },
      { env: { ...railway, CLEANER_TEST_AGENT_TOKEN: "private_short_agent_value" }, message: "CLEANER_TEST_AGENT_TOKEN must contain at least 32" },
      { env: { ...railway, CLEANER_TEST_ADMIN_TOKEN: "private_short_admin_value" }, message: "CLEANER_TEST_ADMIN_TOKEN must contain at least 32" },
      { env: { ...railway, CLEANER_TEST_ADMIN_TOKEN: railway.CLEANER_TEST_AGENT_TOKEN }, message: "must have different values" },
    ];
    for (const { env, message } of inputs) {
      try { resolveTestStartupConfig(env); throw new Error("Expected validation failure"); }
      catch (error) {
        expect(error).toBeInstanceOf(DelegationStartupError);
        expect((error as Error).message).toContain(message);
        for (const value of [env.CLEANER_TEST_AGENT_TOKEN, env.CLEANER_TEST_ADMIN_TOKEN]) {
          if (value) expect((error as Error).message).not.toContain(value);
        }
      }
    }
  });

  it("refuses invalid public addresses without printing credential-bearing URLs", () => {
    for (const url of ["not-an-origin", "http://cleaner.example", "https://user:private_password@cleaner.example", "https://cleaner.example/mcp"]) {
      try { resolveTestStartupConfig({ ...railway, CLEANER_TEST_PUBLIC_URL: url }); throw new Error("Expected validation failure"); }
      catch (error) {
        expect(error).toBeInstanceOf(DelegationStartupError);
        expect((error as Error).message).not.toContain(url);
        expect((error as Error).message).not.toContain("private_password");
      }
    }
  });

  it("refuses missing public addresses, invalid ports, and unsupported listener hosts", () => {
    expect(() => resolveTestStartupConfig({ ...railway, RAILWAY_PUBLIC_DOMAIN: undefined })).toThrow("generate a Railway domain");
    expect(() => resolveTestStartupConfig({ ...railway, PORT: "not_a_port" })).toThrow("PORT");
    expect(() => resolveTestStartupConfig({ ...railway, CLEANER_TEST_HOST: "unexpected_host" })).toThrow("CLEANER_TEST_HOST");
  });
});
