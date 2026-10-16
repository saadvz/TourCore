#!/usr/bin/env node
// Check one step D journey's saved smoke JSON. The scratch door code must
// already be redacted. Exit 1 with a reason when the owner-visible result is wrong.

import { readFileSync } from "node:fs";

const journey = process.argv[2];
const paths = process.argv.slice(3);
if (!journey || paths.length === 0) {
  process.stderr.write("Usage: assert-step-d.mjs <journey> <stdout.json>...\n");
  process.exit(1);
}

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const UNAPPROVED = "+15555550199";
const CHECKOUT_Q = `Is checkout at ${ADDRESS} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
const CHECKIN_Q = `Is check-in at ${ADDRESS} on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.`;
const OFFER = `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`;
const CONFIRM = `Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at ${ADDRESS}.`;
const CONFIRM_2PM = `Cleaning is scheduled for Sunday, Oct 18 at 2:00 PM at ${ADDRESS}.`;
const CORRECTED_2PM = `Update: checkout at ${ADDRESS} moved to Sunday, Oct 18 at 2:00 PM. Reply YES to keep the cleaning, or STOP to opt out.`;
const REMINDER = `Reminder: cleaning at ${ADDRESS} is Sunday, Oct 18 at 11:00 AM.`;
const OPT_IN = `Hi, this is Scratch's cleaning scheduler for ${ADDRESS}. Reply YES to get cleaning texts, or STOP to opt out.`;
const PIN_REDACTED = `Guests have left ${ADDRESS}. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.`;
const PIN_NOTICE = "Door code sent to the cleaner.";
const PIN_FAIL = "The door code didn't reach the cleaner. We'll try again in a few minutes.";
const PIN_HELD = "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
const STARTED = "Got it, cleaning started.";
const DONE_ACK = "Thanks, cleaning marked done.";
const HOST_DONE = `The cleaner marked the cleaning at ${ADDRESS} done.`;
const ALREADY_DONE = "This cleaning is already marked done.";
const BEFORE_CODE = "I'll text you the door code after the guests leave.";
const STOP_ACK = "You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.";
const START_ACK = "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.";
const EMERGENCY = "If someone is hurt, call 911 now.";
const HOST_HURT = `The cleaner at ${ADDRESS} says someone is hurt. They've been told to call 911.`;
const INJURY_HOLD = `The cleaning at ${ADDRESS} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`;
const CLEANER_HURT = "If someone is hurt, call 911 now. I've let the host know.";
const CLEANER_HURT_MISSED = "If someone is hurt, call 911 now. I couldn't reach the host, so please call them too.";
const said = (from, text) => `${from}: ${text}`;

const reports = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const blob = paths.map((path) => readFileSync(path, "utf8")).join("\n");
if (blob.includes("4821")) fail("the scratch door code leaked into the report");
if (/\bready\b/i.test(blob)) fail("a text or status says ready");
for (const report of reports) {
  for (const text of report.sent ?? []) {
    if (text.to !== OWNER && text.to !== CLEANER) fail(`text to ${text.to}`);
    if (text.kind === "pin" && (text.to !== CLEANER || text.body !== PIN_REDACTED)) fail("the private text is not the redacted cleaner text");
    if (text.kind !== "pin" && String(text.body).includes("[redacted]")) fail("a schedule text was redacted");
  }
}

const first = reports[0];
const last = reports[reports.length - 1];

if (journey === "held") {
  same(first.pinRecipients, []);
  same(first.jobs[0]?.status, "awaiting_departure");
  if ((first.sent ?? []).some((text) => text.kind === "pin")) fail("the door code went out before departure");
  if (!first.transcript.includes(OPT_IN) || !first.transcript.includes(CONFIRM)) fail("the held turn skipped opt-in or confirm");
} else if (journey === "released") {
  same(first.pinRecipients, [CLEANER]);
  same(first.jobs[0]?.status, "cleared");
  same(first.sent.filter((text) => text.kind === "pin"), [{ to: CLEANER, body: PIN_REDACTED, kind: "pin" }]);
  same(first.sent.filter((text) => text.kind === "pin-notice"), [{ to: OWNER, body: PIN_NOTICE, kind: "pin-notice" }]);
} else if (journey === "not-opted") {
  same(first.pinRecipients, []);
  if (!first.transcript.includes(OPT_IN)) fail("the cleaner was not asked to opt in");
  if ((first.sent ?? []).some((text) => text.kind === "pin" || text.body === PIN_NOTICE)) fail("a cleaner who did not opt in received access");
} else if (journey === "unapproved-yes") {
  same(first.pinRecipients, []);
  if (!first.transcript.includes(said(UNAPPROVED, "YES"))) fail("the unapproved YES was dropped from the transcript");
  if ((first.sent ?? []).some((text) => text.to === UNAPPROVED)) fail("the unapproved number was texted");
  if ((first.sent ?? []).some((text) => text.kind === "pin")) fail("the unapproved YES released the door code");
} else if (journey === "not-approved") {
  same(first.pinRecipients, []);
  if (first.transcript.includes(OPT_IN)) fail("an unapproved cleaner was asked to opt in");
  if ((first.sent ?? []).some((text) => text.to !== OWNER || text.kind === "pin")) fail("someone other than the host was texted");
} else if (journey === "checkout-moved") {
  const lines = first.transcript;
  if (lines.indexOf(CORRECTED_2PM) > lines.indexOf(CONFIRM_2PM)) fail("the new confirm went out before the correction");
  if (lines.indexOf(CONFIRM_2PM) > lines.indexOf(PIN_REDACTED)) fail("the door code went out before the host confirmed again");
  same(first.sent.filter((text) => text.kind === "pin"), [{ to: CLEANER, body: PIN_REDACTED, kind: "pin" }]);
  same(first.pinRecipients, [CLEANER]);
} else if (journey === "full-turn") {
  same(first.transcript, [
    CHECKOUT_Q,
    OPT_IN,
    said(CLEANER, "YES"),
    said(OWNER, "YES"),
    CHECKIN_Q,
    said(OWNER, "YES"),
    OFFER,
    said(CLEANER, "YES"),
    CONFIRM,
    REMINDER,
    said(OWNER, "guests have left"),
    PIN_REDACTED,
    PIN_NOTICE,
    said(CLEANER, "START"),
    STARTED,
    said(CLEANER, "DONE"),
    DONE_ACK,
    HOST_DONE,
  ]);
  same(first.jobs[0]?.status, "done");
  same(first.pinRecipients, [CLEANER]);
  same(first.sent.map((text) => text.body), [
    CHECKOUT_Q, OPT_IN, CHECKIN_Q, OFFER, CONFIRM, REMINDER, PIN_REDACTED, PIN_NOTICE, STARTED, DONE_ACK, HOST_DONE,
  ]);
} else if (journey === "done-without-start") {
  same(first.transcript, [
    CHECKOUT_Q,
    OPT_IN,
    said(CLEANER, "YES"),
    said(OWNER, "YES"),
    CHECKIN_Q,
    said(OWNER, "YES"),
    OFFER,
    said(CLEANER, "YES"),
    CONFIRM,
    REMINDER,
    said(OWNER, "guests have left"),
    PIN_REDACTED,
    PIN_NOTICE,
    said(CLEANER, "DONE"),
    DONE_ACK,
    HOST_DONE,
    said(CLEANER, "DONE"),
    ALREADY_DONE,
  ]);
  same(first.jobs[0]?.status, "done");
  same(first.pinRecipients, [CLEANER]);
  same(first.sent.filter((text) => text.body === HOST_DONE), [{ to: OWNER, body: HOST_DONE, kind: "done" }]);
  same(first.sent.filter((text) => text.body === DONE_ACK), [{ to: CLEANER, body: DONE_ACK, kind: "done" }]);
  same(first.sent.filter((text) => text.body === ALREADY_DONE), [{ to: CLEANER, body: ALREADY_DONE, kind: "next" }]);
  if (first.sent.some((text) => text.body === STARTED)) fail("START was not required");
} else if (journey === "done-early") {
  same(first.jobs[0]?.status, "awaiting_departure");
  same(first.pinRecipients, []);
  same(first.sent.filter((text) => text.body === BEFORE_CODE), [{ to: CLEANER, body: BEFORE_CODE, kind: "next" }]);
  if ((first.sent ?? []).some((text) => text.kind === "pin" || text.body === HOST_DONE || text.body === DONE_ACK)) {
    fail("DONE before the door code finished the job");
  }
} else if (journey === "stop-holds") {
  same(first.pinRecipients, []);
  same(first.sent.filter((text) => text.body === PIN_HELD), [{ to: OWNER, body: PIN_HELD, kind: "pin-held" }]);
  same(first.sent.filter((text) => text.body === STOP_ACK), [{ to: CLEANER, body: STOP_ACK, kind: "stop" }]);
  same(first.sent.filter((text) => text.body === START_ACK), [{ to: CLEANER, body: START_ACK, kind: "start" }]);
  if ((first.sent ?? []).some((text) => text.kind === "pin")) fail("START resent the door code");
  if (!first.transcript.includes(PIN_HELD)) fail("the held notice is missing from the transcript");
} else if (journey === "help-waiting" || journey === "help-cleared" || journey === "help-progress") {
  const tail = (first.sent ?? []).slice(-4);
  same(tail, [
    { to: OWNER, body: EMERGENCY, kind: "emergency" },
    { to: OWNER, body: HOST_HURT, kind: "emergency" },
    { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
    { to: CLEANER, body: CLEANER_HURT, kind: "emergency" },
  ]);
  if ((first.sent ?? []).some((text) => text.kind === "help")) fail("HELP sent a reply");
  if ([EMERGENCY, HOST_HURT, INJURY_HOLD, CLEANER_HURT].some((body) => body.includes("4821") || body.includes("[redacted]"))) {
    fail("a safety reply includes the door code");
  }
  if (journey === "help-waiting") {
    same(first.pinRecipients, []);
    same(first.jobs[0]?.status, "awaiting_departure");
  } else if (journey === "help-cleared") {
    same(first.pinRecipients, [CLEANER]);
    same(first.jobs[0]?.status, "cleared");
    if (EMERGENCY.includes("[redacted]")) fail("the emergency reply includes the door code");
  } else {
    same(first.jobs[0]?.status, "in_progress");
    if (!first.transcript.includes(STARTED)) fail("cleaning had not started");
    same(first.sent.filter((text) => text.kind === "pin"), [{ to: CLEANER, body: PIN_REDACTED, kind: "pin" }]);
  }
} else if (journey === "injury-failed") {
  same((first.sent ?? []).filter((text) => text.kind === "emergency"), [
    { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
    { to: CLEANER, body: CLEANER_HURT_MISSED, kind: "emergency" },
  ]);
  const host = (first.outbox ?? []).find((item) => item.body === HOST_HURT);
  same(host && { to: host.to, body: host.body, kind: host.kind, status: host.status }, {
    to: OWNER,
    body: HOST_HURT,
    kind: "emergency",
    status: "failed",
  });
  if ((first.transcript ?? []).includes(HOST_HURT)) fail("the failed host alert was saved as delivered");
  if ((first.transcript ?? []).includes(CLEANER_HURT)) fail("the success copy went out after the host alert failed");
  same((first.transcript ?? []).filter((line) => line === CLEANER_HURT_MISSED), [CLEANER_HURT_MISSED]);
  if ((first.sent ?? []).some((text) => text.kind === "pin")) fail("the injury path sent a door code");
} else if (journey === "pin-failed") {
  const [failed, retry, again] = reports;
  if (!failed || !retry || !again) fail("pin-failed needs three reports");
  same(failed.pinRecipients, []);
  same(failed.jobs[0]?.status, "awaiting_departure");
  same(failed.outbox.find((item) => item.kind === "pin"), {
    id: "pin:stay-anita@guesty.com:2026-10-18:660:1",
    to: CLEANER,
    body: PIN_REDACTED,
    kind: "pin",
    status: "failed",
    jobId: "stay-anita@guesty.com",
  });
  if (!failed.transcript.includes(PIN_FAIL)) fail("the host did not see the failure");
  same(failed.sent.filter((text) => text.body === PIN_FAIL), [{ to: OWNER, body: PIN_FAIL, kind: "pin-failed" }]);
  same(retry.sent.filter((text) => text.kind === "pin"), [{ to: CLEANER, body: PIN_REDACTED, kind: "pin" }]);
  same(retry.sent.filter((text) => text.kind === "pin-notice"), [{ to: OWNER, body: PIN_NOTICE, kind: "pin-notice" }]);
  same(retry.jobs[0]?.status, "cleared");
  same(retry.pinRecipients, [CLEANER]);
  same(again.sent, []);
  same(again.transcript.filter((line) => line === PIN_REDACTED), [PIN_REDACTED]);
  same(again.outbox.find((item) => item.kind === "pin")?.status, "sent");
} else if (journey === "no-group") {
  same(first.pinRecipients, [CLEANER]);
  same(first.sent.filter((text) => text.to === UNAPPROVED), []);
  same(first.sent.filter((text) => text.kind === "pin"), [{ to: CLEANER, body: PIN_REDACTED, kind: "pin" }]);
  same(first.sent.filter((text) => text.kind === "pin-notice"), [{ to: OWNER, body: PIN_NOTICE, kind: "pin-notice" }]);
} else if (journey === "pin-stored") {
  same(last.pinRecipients, [CLEANER]);
  same(last.sent.filter((text) => text.kind === "pin"), [{ to: CLEANER, body: PIN_REDACTED, kind: "pin" }]);
  if (!last.transcript.includes(PIN_REDACTED)) fail("the redacted private text is missing");
} else {
  fail(`unknown journey ${journey}`);
}

function same(actual, expected) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) fail(`expected ${right}\nreceived ${left}`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
