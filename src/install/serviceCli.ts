import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultWorkspaceRoot, PropertyWorkspace } from "../setup/workspace";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { loadLocalEnv } from "../web/env";
import { Installation } from "./installation";
import { CloudflareQuickTunnelProvider } from "./publicEndpoint";
import { readRuntimeInfo, ServiceManager, serviceDir } from "./service";
import { useSettingsSource } from "./settings";
import { getInstallationStatus } from "./status";

/**
 * Runtime management for the install layer, on the Tour Core computer only:
 *   npm run service:start     start Tour Core in the background (no-op if it's healthy)
 *   npm run service:stop      stop it (add -- --tunnel to stop the public tunnel too)
 *   npm run service:restart   restart it (the public tunnel, and so its address, is kept)
 *   npm run service:status    is it running, and is it healthy
 *   npm run install:status    the installation status, component by component
 *   npm run install:link      a fresh secure setup link (this computer's browser only)
 * None of these is reachable from an operator tool.
 */

const say = (line = "") => console.log(line ? `  ${line}` : "");

loadLocalEnv();
const [command, ...rest] = process.argv.slice(2);
const root = defaultWorkspaceRoot();
const repoDir = fileURLToPath(new URL("../..", import.meta.url));
const runtime = new FileRuntimeStore(join(root, "runtime"));
const installation = new Installation({ root, runtime });
useSettingsSource(installation.settingsSource());
const port = Number(rest.find((a) => a.startsWith("--port="))?.split("=")[1] ?? readRuntimeInfo(root)?.port ?? 4321);
const service = new ServiceManager({ root, repoDir, port });

async function main(): Promise<number> {
  switch (command) {
    case "start": {
      const s = await service.start();
      say(s.healthy ? (s.started ? `Started Tour Core at ${s.localUrl}.` : `Tour Core is already running at ${s.localUrl}.`) : s.message);
      return s.healthy ? 0 : 1;
    }
    case "stop": {
      const s = await service.stop();
      say(s.message);
      if (rest.includes("--tunnel")) {
        await new CloudflareQuickTunnelProvider({ serviceDir: serviceDir(root), binDir: join(root, "bin") }).stop();
        say("Stopped the public tunnel. Its address will change when it starts again.");
      }
      return 0;
    }
    case "restart": {
      const s = await service.restart();
      say(s.healthy ? `Restarted Tour Core at ${s.localUrl}.` : s.message);
      return s.healthy ? 0 : 1;
    }
    case "status": {
      const s = await service.status();
      say(s.message);
      if (s.localUrl) say(`Local address: ${s.localUrl}`);
      if (s.pid) say(`Process: ${s.pid}`);
      say(`Log: ${service.logPath}`);
      return s.healthy ? 0 : 1;
    }
    case "install-status": {
      const s = await service.status();
      const status = getInstallationStatus(installation, { workspace: new PropertyWorkspace(root), runtime }, { runtime: { running: s.healthy, message: s.message } });
      say(`${status.deploymentLabel}: ${status.summary}`);
      for (const line of status.lines) say(`  ${line}`);
      say(`Next: ${status.nextStep.operatorMessage}`);
      return 0;
    }
    case "link": {
      const s = await service.status();
      const { token } = installation.sessions.mint();
      say("Secure setup (open in this computer's browser; expires in 30 minutes):");
      say(`  ${s.localUrl ?? `http://localhost:${port}`}/install#s=${token}`);
      if (!s.healthy) say("Tour Core isn't running yet: run npm run service:start first.");
      return 0;
    }
    default:
      say("Usage: npm run service:start | service:stop | service:restart | service:status | install:status | install:link");
      return 1;
  }
}

process.exit(await main());
