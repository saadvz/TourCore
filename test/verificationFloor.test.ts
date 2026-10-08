import { describe, expect, it } from "vitest";
import { grokHarness } from "./grokHarness";

const CLIENTS = ["grok", "chatgpt", "claude", "mystery-client"] as const;

async function liveProperty() {
  const h = grokHarness();
  h.ctx.services.installedMessaging = () => ({ mode: "live", provider: "sendblue", ready: true, requiredForPublish: false });
  const created = await h.ok("create_property_setup", { address: "18 Maple Street, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
  const propertyId = created.setup.propertyId as string;
  await h.ok("set_services", { property: propertyId, messaging: "live" });
  return { h, propertyId };
}

describe("identity-check floor", () => {
  it("refuses practice on a live property for grok, chatgpt, claude, and an unknown client", async () => {
    const { h, propertyId } = await liveProperty();
    try {
      for (const name of CLIENTS) {
        h.ctx.client = { name };
        const saved = await h.ok("save_settings", { property: propertyId, verification: "practice" });
        expect(saved.status, name).toBe("blocked");
        expect(saved.code, name).toBe("VERIFICATION_BELOW_FLOOR");
        expect(h.workspace.openDraft(propertyId).draft.verificationMode, name).toBe("basic-form");
        const old = await h.ok("set_verification_policy", { property: propertyId, level: "practice" });
        expect(old.status, name).toBe("blocked");
        expect(old.code, name).toBe("VERIFICATION_BELOW_FLOOR");
        expect(h.workspace.openDraft(propertyId).draft.verificationMode, name).toBe("basic-form");
      }
    } finally {
      h.cleanup();
    }
  });

  it("keeps the basic identity form when a live property asks for a full ID check", async () => {
    const { h, propertyId } = await liveProperty();
    try {
      const saved = await h.ok("save_settings", { property: propertyId, verification: "document-check" });
      expect(saved.status).toBe("done");
      expect(saved.message).toBe("A full ID check isn't available yet, so visitors will fill out a basic identity form instead.");
      expect(h.workspace.openDraft(propertyId).draft.verificationMode).toBe("basic-form");
    } finally {
      h.cleanup();
    }
  });

  it("keeps the basic identity form when a full ID check is requested in demo", async () => {
    const h = grokHarness();
    try {
      const created = await h.ok("create_property_setup", { address: "18 Maple Street, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
      const propertyId = created.setup.propertyId as string;
      const saved = await h.ok("save_settings", { property: propertyId, verification: "document-check" });
      expect(saved.status).toBe("done");
      expect(saved.message).toBe("A full ID check isn't available yet, so visitors will fill out a basic identity form instead.");
      expect(h.workspace.openDraft(propertyId).draft.verificationMode).toBe("basic-form");
    } finally {
      h.cleanup();
    }
  });

  it("allows practice verification in demo mode", async () => {
    const h = grokHarness();
    try {
      const created = await h.ok("create_property_setup", { address: "18 Maple Street, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
      const propertyId = created.setup.propertyId as string;
      const saved = await h.ok("save_settings", { property: propertyId, verification: "practice" });
      expect(saved.status).toBe("done");
      expect(h.workspace.openDraft(propertyId).draft.verificationMode).toBe("mock");
    } finally {
      h.cleanup();
    }
  });

  it("allows practice verification on local test texting", async () => {
    const h = grokHarness();
    try {
      h.ctx.services.installedMessaging = () => ({ mode: "live", provider: "local", ready: true, requiredForPublish: false });
      const created = await h.ok("create_property_setup", { address: "18 Maple Street, Teaneck, NJ 07666", propertyType: "MULTIFAMILY_HOME" });
      const propertyId = created.setup.propertyId as string;
      await h.ok("set_services", { property: propertyId, messaging: "local" });
      const saved = await h.ok("save_settings", { property: propertyId, verification: "practice" });
      expect(saved.status).toBe("done");
      expect(h.workspace.openDraft(propertyId).draft.verificationMode).toBe("mock");
    } finally {
      h.cleanup();
    }
  });
});
