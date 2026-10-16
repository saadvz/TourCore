import { afterAll } from "vitest";
import { setCleanerAlertFetch, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { setCleanerPhotoFetch } from "../src/cleaner-core/photos";
import { useSettingsSource } from "../src/install/settings";
import { resetLocalSmsOutbox } from "../src/messaging/local/outbox";
import { bindMessagingInstallation } from "../src/messaging/registry";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { setTwilioClient } from "../src/messaging/twilio/provider";

/**
 * Test files share one module graph (isolate: false), so a file that leaves a
 * stub, a registered server, or an env var behind would leak into the next
 * file. Put every test hook and the environment back after each file.
 */

type Defaults = { sendblue: () => void; twilio: () => void; env: NodeJS.ProcessEnv };
const g = globalThis as { __tourCoreTestDefaults?: Defaults };
// The first file in a worker sees the untouched modules; keep restore
// functions that put those originals back.
g.__tourCoreTestDefaults ??= (() => {
  const sendblue = setSendblueRuntime({});
  const twilio = setTwilioClient(() => {
    throw new Error("unreachable");
  });
  twilio();
  return { sendblue, twilio, env: { ...process.env } };
})();
const defaults = g.__tourCoreTestDefaults;

afterAll(() => {
  defaults.sendblue();
  defaults.twilio();
  useSettingsSource({});
  bindMessagingInstallation(() => undefined as never);
  resetLocalSmsOutbox();
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerPhotoFetch(undefined);
  setCleanerCalendarFetch(undefined);
  setCleanerAlertFetch(undefined);
  for (const key of Object.keys(process.env)) if (!(key in defaults.env)) delete process.env[key];
  Object.assign(process.env, defaults.env);
});
