import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Installation } from "../src/install/installation";
import { annotationsFor } from "../src/mcp/annotations";
import { OPERATOR_TOOLS } from "../src/operator/tools";
import { FakeGoogleDrive } from "../src/storage/googleDrive";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { grokHarness } from "./grokHarness";

describe("export_records", () => {
  it("is not read-only, and its files go through the Drive save", async () => {
    const tool = OPERATOR_TOOLS.find((item) => item.name === "export_records");
    expect(tool?.kind).toBe("change");
    expect(annotationsFor(tool!)).toMatchObject({ readOnlyHint: false, destructiveHint: false });

    const h = grokHarness();
    const drive = new FakeGoogleDrive();
    try {
      const inst = new Installation({
        root: h.root,
        runtime: new FileRuntimeStore(join(h.root, "runtime")),
        env: () => ({}),
        now: () => h.now(),
        driveClient: drive,
      });
      h.ctx.installation = inst;
      inst.files.ensure({ deploymentMode: "LOCAL_DEVELOPER" });
      inst.secrets.set({ GOOGLE_OAUTH_REFRESH_TOKEN: "google-refresh-test-token" });
      expect((await inst.records.finish()).ok).toBe(true);
      expect(inst.records.provider()).toBe("GOOGLE_DRIVE_READY");

      const propertyId = await h.publish();

      let commits = 0;
      const commitLocal = inst.records.commitLocal.bind(inst.records);
      inst.records.commitLocal = async () => {
        commits += 1;
        await commitLocal();
      };

      await h.ok("get_tours", { property: propertyId });
      expect(commits).toBe(0);

      const exported = await h.ok("export_records", { property: propertyId, day: "today" });
      expect(exported.files.map((file: { file: string }) => file.file)).toEqual(["audit-export.json", "audit.csv"]);
      expect(commits).toBe(1);
      const paths = [...drive.files.values()].map((file) => file.meta.appProperties.tourCorePath).filter((path): path is string => !!path);
      expect(paths.some((path) => path.includes("/audit-exports/") && path.endsWith("/audit-export.json"))).toBe(true);

      commits = 0;
      const readable = await h.ok("export_records", { kind: "readable" });
      expect(readable.fileName).toBeTruthy();
      expect(commits).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});
