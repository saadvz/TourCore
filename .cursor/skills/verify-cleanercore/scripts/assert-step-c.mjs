#!/usr/bin/env node
// Check one step C journey's saved smoke JSON. Exit 1 with a reason when the
// owner-visible result is wrong. Never accepts a door code.

import { readFileSync } from "node:fs";

const journey = process.argv[2];
const paths = process.argv.slice(3);
if (!journey || paths.length === 0) {
  process.stderr.write("Usage: assert-step-c.mjs <journey> <stdout.json>...\n");
  process.exit(1);
}

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CHECKOUT_Q = `Is checkout at ${ADDRESS} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
const CHECKIN_Q = `Is check-in at ${ADDRESS} on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.`;
const OFFER = `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`;
const OFFER_1PM = `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 1:00 PM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`;
const CONFIRM = `Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at ${ADDRESS}.`;
const CONFIRM_1PM = `Cleaning is scheduled for Sunday, Oct 18 at 1:00 PM at ${ADDRESS}.`;
const CORRECTED_1PM = `Update: checkout at ${ADDRESS} moved to Monday, Oct 19 at 1:00 PM. Reply YES to keep the cleaning, or STOP to opt out.`;
const CORRECTED_11 = `Update: checkout at ${ADDRESS} moved to Monday, Oct 19 at 11:00 AM. Reply YES to keep the cleaning, or STOP to opt out.`;
const CANCEL = `Update: checkout at ${ADDRESS} on Sunday, Oct 18 is canceled. Reply STOP to opt out.`;
const REMINDER = `Reminder: checkout at ${ADDRESS} is Sunday, Oct 18 at 11:00 AM. Reply STOP to opt out.`;
const STOP_ACK = "Tour Core: You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.";
const HELP_ACK = "Cleaner Core: Reply here if you need help with this turnover. Reply STOP to opt out.";
const EMERGENCY = "If someone is hurt, call 911 now. I couldn't reach the property team just now.";
const NEXT_Q = `Is checkout at ${ADDRESS} on Tuesday, Oct 20 still 11:00 AM? Reply YES or send the new time.`;

const reports = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const blob = paths.map((path) => readFileSync(path, "utf8")).join("\n");
if (blob.includes("4821") || blob.toLowerCase().includes("door code")) fail("door code leaked into the report");
for (const report of reports) {
  if ((report.pinRecipients ?? []).length !== 0) fail("pinRecipients is not empty");
  if ((report.sent ?? []).some((text) => text.kind === "pin")) fail("a pin text was sent");
  if ((report.sent ?? []).some((text) => text.to !== OWNER && text.to !== "+15555550101")) fail("text to a non-Scratch recipient");
}

const first = reports[0];
const last = reports[reports.length - 1];
const transcript = last.transcript ?? [];

if (journey === "read-feed") {
  same(first.transcript, [CHECKOUT_Q]);
  same(first.jobs.map(slim), [
    { id: "stay-anita@guesty.com", checkoutDate: "2026-10-18", nextCheckInDate: "2026-10-18", sameDay: true, live: true, checkoutTime: null },
    { id: "stay-same-day@guesty.com", checkoutDate: "2026-10-20", nextCheckInDate: "2026-10-22", sameDay: false, live: true, checkoutTime: null },
    { id: "stay-after-gap@guesty.com", checkoutDate: "2026-10-24", nextCheckInDate: null, sameDay: false, live: true, checkoutTime: null },
  ]);
  same(first.blocks.map((block) => block.uid), ["block-owner@guesty.com", "block-date@guesty.com"]);
  if (first.jobs.some((job) => String(job.id).startsWith("block-"))) fail("a block became a job");
} else if (journey === "host-time") {
  same(first.transcript, [CHECKOUT_Q, CHECKIN_Q, OFFER_1PM]);
  if (first.jobs[0]?.checkoutTime !== "1:00 PM" || first.jobs[0]?.checkoutAt !== "2026-10-18T17:00:00.000Z") fail("host checkout did not stick");
  if (blob.includes("10:00")) fail("the feed clock was used");
} else if (journey === "corrected-time") {
  same(first.transcript, [CHECKOUT_Q, CHECKIN_Q, OFFER_1PM, CONFIRM_1PM, CORRECTED_1PM]);
  const anita = first.jobs.filter((job) => job.id === "stay-anita@guesty.com");
  if (anita.length !== 1 || anita[0].live !== true || anita[0].checkoutDate !== "2026-10-19" || anita[0].checkoutTime !== "1:00 PM") {
    fail("corrected job is not the one live host time");
  }
  if (first.transcript.filter((line) => line.startsWith("Turnover at")).length !== 1) fail("the correction looked like a second offer");
} else if (journey === "reminder-once") {
  const [ran, again] = reports;
  if (!ran || !again) fail("reminder journey needs two reports");
  if (ran.transcript.filter((line) => line === REMINDER).length !== 1) fail("first run did not send the reminder once");
  if ((again.sent ?? []).length !== 0) fail("restart sent the reminder again");
  if (again.transcript.filter((line) => line === REMINDER).length !== 1) fail("restart changed the reminder transcript");
} else if (journey === "blocks") {
  same(first.jobs, []);
  same(first.sent, []);
  same(first.transcript ?? [], []);
  same(first.blocks.map((block) => block.uid), ["block-owner@guesty.com", "block-date@guesty.com"]);
} else if (journey === "one-live-job") {
  same(first.transcript, [CHECKOUT_Q, CHECKIN_Q, OFFER, CANCEL]);
  const liveAnita = first.jobs.filter((job) => job.id === "stay-anita@guesty.com" && job.live);
  if (liveAnita.length !== 0) fail("the removed stay is still live");
  const anita = first.jobs.filter((job) => job.id === "stay-anita@guesty.com");
  if (anita.length !== 1 || anita[0].status !== "canceled") fail("the removed stay is not one canceled job");
  const ids = first.jobs.map((job) => job.id);
  if (new Set(ids).size !== ids.length) fail("two job rows share an id");
} else if (journey === "stop-silences") {
  if (transcript.at(-1) !== STOP_ACK) fail("STOP was not the last text");
  if (transcript.includes(CORRECTED_11) || transcript.includes(CORRECTED_1PM) || transcript.includes(REMINDER)) fail("a text went out after STOP");
  if ((first.sent ?? []).some((text) => text.body === CORRECTED_11 || text.body === REMINDER)) fail("sent a corrected text or reminder after STOP");
} else if (journey === "no-pin") {
  same(first.transcript, [CHECKOUT_Q, CHECKIN_Q, OFFER, CONFIRM]);
  if (first.jobs.some((job) => job.status === "ready")) fail("a job was marked ready");
} else if (journey === "safety-states") {
  const replies = {
    stop: STOP_ACK,
    help: HELP_ACK,
    emergency: EMERGENCY,
  };
  if (reports.length !== 9) fail("safety journey needs nine reports");
  const names = ["waiting-stop", "waiting-help", "waiting-emergency", "offered-stop", "offered-help", "offered-emergency", "corrected-stop", "corrected-help", "corrected-emergency"];
  reports.forEach((report, index) => {
    const name = names[index] ?? String(index);
    const phrase = name.endsWith("stop") ? "stop" : name.endsWith("help") ? "help" : "emergency";
    const body = replies[phrase];
    if (report.transcript?.at(-1) !== body) fail(`${name} last text was not the safety reply`);
    if (name.startsWith("waiting") && report.jobs[0]?.status !== "discovered") fail(`${name} advanced the job`);
    if (name.startsWith("offered") && report.jobs[0]?.status !== "offered") fail(`${name} left the offered job`);
    if (name.startsWith("corrected") && report.jobs[0]?.status === "confirmed") fail(`${name} confirmed the old time`);
    if (name.startsWith("offered") && report.transcript?.includes(CONFIRM)) fail(`${name} sent the confirmation`);
  });
} else if (journey === "failed-send") {
  const [failed, retried, restarted] = reports;
  if (!failed || !retried || !restarted) fail("failed-send needs three reports");
  const failedReminder = (failed.outbox ?? []).find((item) => item.kind === "reminder");
  if (!failedReminder || failedReminder.status !== "failed") fail("the failed reminder was marked sent");
  if ((failed.transcript ?? []).includes(REMINDER)) fail("the failed send was recorded as delivered");
  if ((retried.sent ?? []).map((text) => text.body).filter((body) => body === REMINDER).length !== 1) fail("the retry did not send the reminder once");
  if ((restarted.sent ?? []).length !== 0) fail("a later run sent the reminder again");
  if ((restarted.transcript ?? []).filter((line) => line === REMINDER).length !== 1) fail("the transcript does not contain the reminder once");
} else fail(`unknown journey ${journey}`);

if (journey === "one-live-job" && transcript.includes(NEXT_Q)) fail("the removal poll also started the next turnover");
process.exit(0);

function slim(job) {
  return {
    id: job.id,
    checkoutDate: job.checkoutDate,
    nextCheckInDate: job.nextCheckInDate,
    sameDay: job.sameDay,
    live: job.live,
    checkoutTime: job.checkoutTime,
  };
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
