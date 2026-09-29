import { cpSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/web/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/server.js",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});
await build({
  entryPoints: ["src/install/ownerClaimCli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/owner-claim.js",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});
cpSync("src/web/public", "dist/public", { recursive: true });
