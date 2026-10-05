import { loadLocalEnv } from "../web/env";
import { runStorageCheck } from "./persistentVolume";

loadLocalEnv();
const args = process.argv.slice(2).filter((a) => a !== "--check-storage");
const pathArg = args.find((a) => !a.startsWith("-"));
const env = pathArg ? { ...process.env, TOURCORE_HOME: pathArg } : process.env;
process.exit(runStorageCheck(env));
