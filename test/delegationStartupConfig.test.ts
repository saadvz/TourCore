import { describe, expect, it } from "vitest";
import { DelegationStartupError, resolveTestStartupConfig } from "../src/delegation/startupConfig";

const railway = { CLEANER_TEST_HOST: "0.0.0.0", RAILWAY_PUBLIC_DOMAIN: "cleaner.example", PORT: "8080", CLEANER_TEST_AGENT_TOKEN: "a".repeat(32), CLEANER_TEST_ADMIN_TOKEN: "b".repeat(32) };

describe("Cleaner Core deployment configuration", () => {
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
