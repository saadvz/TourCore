import { join } from "node:path";
import { Installation } from "./installation";
import { ownerClaimInstructions } from "./hostedOwner";
import { readSendblueEnv } from "../messaging/sendblue/runtime";
import { defaultWorkspaceRoot } from "../setup/workspace";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { loadLocalEnv } from "../web/env";

/**
 * Prints a one-time hosted owner claim link. Run on the Railway service
 * (the data volume must be mounted). The link is not written to the service log.
 */
loadLocalEnv();
const root = defaultWorkspaceRoot();
let inst!: Installation;
inst = new Installation({
  root,
  runtime: new FileRuntimeStore(join(root, "runtime")),
  env: () => process.env,
  sendblueEnv: () => readSendblueEnv(inst.env()),
});
const text = ownerClaimInstructions(inst);
console.log(text);
if (text.startsWith("No one-time claim") || text.startsWith("This hosted installation is already claimed")) process.exitCode = 1;
