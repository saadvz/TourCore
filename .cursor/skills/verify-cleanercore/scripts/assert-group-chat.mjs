#!/usr/bin/env node
// Assert one group-chat smoke stdout. Digits stay out of this file.

import { readFileSync } from "node:fs";

const [journey, actualPath] = process.argv.slice(2);
if (!journey || !actualPath) {
  process.stderr.write("Usage: assert-group-chat.mjs <journey> <stdout>\n");
  process.exit(1);
}

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const EXTRA = "+15555550122";
const HOLD = `The cleaning at ${ADDRESS} is on hold until the cleaner replies YES.`;
const STOP_HOLD = `The cleaner opted out of cleaning texts for ${ADDRESS}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell your Grok Bot to restart it.`;
const HOST_RESTART = new Set([
  STOP_HOLD,
  `The cleaning at ${ADDRESS} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`,
  `The cleaning at ${ADDRESS} is on hold because you opted out of texts. Tell your Grok Bot to restart it.`,
  `You'll get cleaning texts for ${ADDRESS} again. The cleaning is still on hold. Tell your Grok Bot to restart it.`,
  "The door code didn't reach the cleaner. Tell your Grok Bot the guests have left and I'll resend it.",
  "Got it. To send the door code, tell your Grok Bot the guests have left. The cleaner is still waiting for the OK.",
]);
const RESUME = `The cleaning at ${ADDRESS} is back on.`;
const TIME = "Cory will confirm that time.";
const PRIVATE_LINE = "Maria got the door code privately.";
const PRIVATE_PIN = `Guests have left ${ADDRESS}. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.`;
const READY = `The cleaner marked the cleaning at ${ADDRESS} done.`;
const OFFER_COPY = `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. The cleaner will reply to confirm.`;
const HURT = "If someone is hurt, call 911 now. I've let the host know.";
const HOST_HURT = `The cleaner at ${ADDRESS} says someone is hurt. They've been told to call 911.`;
const INJURY_HOLD = `The cleaning at ${ADDRESS} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`;

const report = JSON.parse(readFileSync(actualPath, "utf8"));
const sent = report.sent ?? [];
const groups = sent.filter((text) => text.channel === "group");
const pins = sent.filter((text) => text.kind === "pin");
const clock = (report.jobs ?? []).find((job) => job.checkoutTime === "11:00 AM");

function fail(message) {
  process.stderr.write(`${journey}: ${message}\n`);
  process.exit(1);
}

function scratch(phone) {
  return typeof phone === "string" && /^\+1555\d{7}$/.test(phone);
}

for (const text of sent) {
  if (!scratch(text.to)) fail(`recipient ${text.to}`);
  for (const phone of text.audience ?? []) {
    if (!scratch(phone)) fail(`audience ${phone}`);
  }
  if (/twilio|engine|cleaner_core/i.test(text.body)) fail(`named a setting: ${text.kind}`);
  if (/grok bot/i.test(text.body) && !HOST_RESTART.has(text.body)) fail(`named a setting: ${text.kind}`);
}
for (const text of groups) {
  if (/\byou\b/i.test(text.body)) fail(`group text says you: ${text.body}`);
}
for (const match of JSON.stringify(report).matchAll(/\+1\d{10}/g)) {
  if (!scratch(match[0])) fail(`non-scratch ${match[0]}`);
}

const checks = {
  eligible() {
    if (pins.length !== 1) fail(`pin count ${pins.length}`);
    if (pins[0].channel || pins[0].to !== CLEANER) fail("pin route");
    if (pins[0].body !== PRIVATE_PIN) fail("pin body");
    if (groups.some((text) => text.body.includes("Door code") || text.body.includes("[redacted]"))) fail("group saw the code");
    if (!clock || clock.status !== "cleared") fail("job");
  },
  private() {
    if (pins.length !== 1 || pins[0].channel || pins[0].body !== PRIVATE_PIN || pins[0].to !== CLEANER) fail("private pin");
    if (sent.some((text) => text.body === PRIVATE_LINE)) fail("private line was sent");
    if (groups.some((text) => text.body === PRIVATE_LINE)) fail("group saw the private line");
    if (groups.some((text) => text.body.includes("[redacted]"))) fail("group saw the code");
    if (sent.filter((text) => text.to === EXTRA).some((text) => text.body.includes("[redacted]"))) fail("extra saw the code");
  },
  held() {
    if (pins.length !== 0) fail("pin sent");
    if (groups.length !== 1 || groups[0].body !== OFFER_COPY) fail("group text");
    if (!sent.some((text) => text.to === OWNER && text.body === STOP_HOLD)) fail("stop hold");
    if (sent.some((text) => text.to === CLEANER && text.body.includes("[redacted]"))) fail("cleaner saw the code");
    if (!clock || clock.status === "cleared" || clock.status === "done") fail("job moved");
  },
  "stop-host"() {
    const time = groups.filter((text) => text.body === TIME);
    if (time.length !== 1) fail("time reply");
    if (JSON.stringify(time[0].audience) !== JSON.stringify([CLEANER])) fail("host still in the audience");
    if (sent.some((text) => text.to === OWNER && text.body === TIME)) fail("time went to the host");
  },
  resume() {
    const notes = sent.filter((text) => text.body === RESUME);
    if (notes.length !== 1 || notes[0].to !== OWNER || notes[0].channel) fail("resume");
    if (sent.some((text) => text.to === CLEANER && text.body === RESUME)) fail("resume went to the cleaner");
    if (sent.some((text) => /opted back in/i.test(text.body))) fail("START opted the cleaner back in");
    if (!sent.some((text) => text.to === OWNER && text.body === STOP_HOLD)) fail("stop hold");
  },
  time() {
    if (!clock || clock.checkoutTime !== "11:00 AM") fail("clock moved");
    const copy = groups.filter((text) => text.body === OFFER_COPY);
    if (copy.length !== 1 || JSON.stringify(copy[0].audience) !== JSON.stringify([OWNER, CLEANER])) fail("offer copy");
    if (groups.filter((text) => text.body === TIME).length !== 1) fail("time reply");
    if (groups.some((text) => text.body !== TIME && text.body !== OFFER_COPY)) fail("extra group text");
  },
  injury() {
    const emergency = sent.filter((text) => text.kind === "emergency");
    if (emergency.length !== 3) fail("911 count");
    if (emergency[0].to !== OWNER || emergency[0].body !== HOST_HURT || emergency[0].channel) fail("host 911");
    if (emergency[1].to !== OWNER || emergency[1].body !== INJURY_HOLD || emergency[1].channel) fail("injury hold");
    if (emergency[2].to !== CLEANER || emergency[2].body !== HURT || emergency[2].channel) fail("cleaner 911");
    if (groups.length !== 1 || groups[0].body !== OFFER_COPY) fail("group saw 911");
    if (sent.some((text) => text.body === TIME)) fail("group handling ran first");
  },
  problem() {
    if (groups.length !== 1 || groups[0].body !== OFFER_COPY) fail("group saw the hold");
    if (!sent.some((text) => text.to === OWNER && text.kind === "review" && text.body === HOLD)) fail("host hold");
    if (!sent.some((text) => text.to === CLEANER && text.kind === "held" && text.body === HOLD)) fail("cleaner hold");
    if (pins.length !== 0) fail("pin during hold");
  },
  "before-yes"() {
    if (groups.length !== 0) fail("group text before YES");
    if (pins.length !== 0) fail("pin");
  },
  inert() {
    if (groups.length !== 0) fail("group text without the option");
    if (pins.length !== 1 || pins[0].channel || pins[0].body !== PRIVATE_PIN) fail("old pin");
    if (sent.some((text) => /cleaning group/i.test(text.body))) fail("group invite");
  },
  "done-without-start"() {
    const finished = (report.jobs ?? []).find((job) => job.status === "done");
    if (!finished) fail("not done");
    if (sent.some((text) => text.body === "Got it, cleaning started.")) fail("start");
    if (sent.filter((text) => text.to === CLEANER && text.body === "Thanks, cleaning marked done.").length !== 1) fail("done");
    const ready = sent.filter((text) => text.to === OWNER && text.body === READY);
    if (ready.length !== 1 || ready[0].channel) fail("ready line");
    const again = sent.filter((text) => text.body === "This cleaning is already marked done.");
    if (again.length !== 1 || again[0].to !== CLEANER || again[0].channel) fail("second done");
    if (groups.some((text) => text.body.includes("Door code") || text.body.includes("[redacted]"))) fail("group saw the code");
  },
  done() {
    const finished = (report.jobs ?? []).find((job) => job.status === "done");
    if (!finished) fail("not done");
    if (!sent.some((text) => text.to === CLEANER && text.body === "Got it, cleaning started.")) fail("start");
    if (!sent.some((text) => text.to === CLEANER && text.body === "Thanks, cleaning marked done.")) fail("done");
    const ready = sent.filter((text) => text.to === OWNER && text.body === READY);
    if (ready.length !== 1 || ready[0].channel) fail("ready line");
    if (groups.some((text) => text.body.includes("Door code") || text.body.includes("[redacted]"))) fail("group saw the code");
  },
  twice() {
    if (pins.length !== 1 || pins[0].body !== PRIVATE_PIN || pins[0].channel) fail("second pin");
    if (groups.some((text) => text.body.includes("Door code") || text.body.includes("[redacted]"))) fail("group saw the code");
  },
  failed() {
    if (pins.length !== 1 || pins[0].channel || pins[0].to !== CLEANER || pins[0].body !== PRIVATE_PIN) fail("private retry");
    if (groups.some((text) => text.body.includes("Door code") || text.body.includes("[redacted]"))) fail("group saw the code");
  },
};

const check = checks[journey];
if (!check) fail("unknown journey");
check();
