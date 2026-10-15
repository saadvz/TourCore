#!/usr/bin/env node
// Check one step G journey's saved smoke JSON. Pins must already be redacted.

import { readFileSync } from "node:fs";

const journey = process.argv[2];
const paths = process.argv.slice(3);
if (!journey || paths.length === 0) {
  process.stderr.write("Usage: assert-step-g.mjs <journey> <stdout.json>...\n");
  process.exit(1);
}

const LANE = "12 Scratch Lane, Teaneck, NJ 07666";
const COURT = "8 Scratch Court, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const OBSERVER = "+15555550122";
const UNAPPROVED = "+15555550199";
const COURT_OWNER = "+15555550110";
const CHECKOUT_Q = `Is checkout at ${LANE} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
const CHECKIN_Q = `Is check-in at ${LANE} on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.`;
const OFFER = `Turnover at ${LANE} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`;
const OFFER_2PM = `Turnover at ${LANE} on Sunday, Oct 18. Checkout 2:00 PM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`;
const WAIT_OFFER = OFFER.replace("Reply YES to schedule it, or STOP to opt out.", "The cleaner will reply to confirm.");
const GROUP = "Group text: ";
const MIRROR = "Copy of the group text: ";
const STALE = `I can't see the latest bookings for ${LANE} right now, so I'm holding new cleanings and the door code. I'll pick back up once the calendar updates. If a time changed, just text it to me.`;
const UNCERTAIN = "My cleaning offer to the cleaner for Sunday, Oct 18 may not have gone out. I didn't resend it. Reply RETRY to send it again.";
const UNCERTAIN_QUEUE = "My cleaning offer to the cleaner for Wednesday, Oct 14 may not have gone out. I didn't resend it. Reply RETRY to send it again.";
const REMINDER_MISSED = "My reminder to the cleaner for Wednesday, Oct 14 didn't go out. I didn't resend it. Reply RETRY to send it again.";
const EXPOSURE = "I held a text to the cleaner because it looked like it had the door code in it.";
const AIRBNB = `I saved a manual Airbnb booking exception for ${LANE}. I did not change the cleaning until you confirm it.`;
const PIN = `Guests have left ${LANE}. Door code: [redacted]. This code is only for you.`;
const PIN_NOTICE = "Door code sent to the cleaner.";
const HEALTH = "Cleaner Core health. This check does not send texts.";
const STOP_ACK = `You're opted out of cleaning texts for ${LANE}. Reply START to get texts again.`;
const EMERGENCY = "If someone is hurt, call 911 now.";
const HOST_HURT = `The cleaner at ${LANE} says someone is hurt. They've been told to call 911.`;
const OBSERVER_HURT = `An observer at ${LANE} says someone is hurt. They've been told to call 911.`;
const CLEANER_HURT = "If someone is hurt, call 911 now. I've let the host know.";
const OPT_IN = `Hi, this is Scratch's cleaning scheduler for ${LANE}. Reply YES to get cleaning texts, or STOP to opt out.`;
const HOLD = `The cleaning at ${LANE} is on hold until the cleaner replies YES.`;
const COURT_MONDAY = `Is checkout at ${COURT} on Monday, Oct 19 still 11:00 AM? Reply YES or send the new time.`;
const REVIEWS = [
  ["stale-source", STALE],
  ["airbnb-exception", AIRBNB],
  ["same-day-capacity", `Same-day cleaning at ${LANE} may be too tight. I saved it for your review and did not add another offer.`],
  ["missed-reminder", REMINDER_MISSED],
  ["conflicting-replies", `I got conflicting replies about the cleaning at ${LANE}. I did not change the job.`],
  ["failed-sms", "A text failed to send. I saved it for your review and did not count it as delivered."],
  ["uncertain-sms", UNCERTAIN_QUEUE],
  ["shared-chat-routing", `I could not tell who should get the cleaning texts at ${LANE}. I did not start a group or send the door code.`],
  ["possible-code-exposure", EXPOSURE],
];

const reports = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const blob = paths.map((path) => readFileSync(path, "utf8")).join("\n");

function fail(reason) {
  process.stderr.write(`${journey}: ${reason}\n`);
  process.exit(1);
}

function same(actual, expected) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) fail(`expected ${right} but got ${left}`);
}

function auditOk(report) {
  if (!Array.isArray(report.audit) || report.audit.length === 0) fail("audit trail is empty");
  for (const event of report.audit) {
    if (!event.actor || !event.source || typeof event.version !== "number" || !event.reason || !event.at || !event.action) {
      fail("an audit event is missing actor, source, version, reason, or time");
    }
  }
}

const first = reports[0];
const last = reports[reports.length - 1];

if (journey === "stale-source") {
  same(first.sent, [
    { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
    { to: CLEANER, body: OPT_IN, kind: "opt-in" },
    { to: OWNER, body: CHECKIN_Q, kind: "host-checkin" },
    { to: OWNER, body: STALE, kind: "review" },
    { to: CLEANER, body: OFFER, kind: "offer" },
  ]);
  same(first.reviews.map((item) => ({ kind: item.kind, status: item.status })), [{ kind: "stale-source", status: "resolved" }]);
  same(first.sources.map((item) => item.freshness), ["fresh"]);
  same(first.pinRecipients, []);
  if (first.sent.filter((text) => text.kind === "offer").length !== 1) fail("the offer was repeated");
  if (first.sent.filter((text) => text.kind === "review").length !== 1) fail("the stale alert was repeated");
  auditOk(first);
} else if (journey === "host-override-beats-stale-feed") {
  same(first.sent, [
    { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
    { to: CLEANER, body: OPT_IN, kind: "opt-in" },
    { to: OWNER, body: CHECKIN_Q, kind: "host-checkin" },
    { to: CLEANER, body: OFFER_2PM, kind: "offer" },
  ]);
  const job = first.jobs.find((item) => item.id === "stay-anita@guesty.com");
  same(job && { checkoutDate: job.checkoutDate, checkoutTime: job.checkoutTime }, { checkoutDate: "2026-10-18", checkoutTime: "2:00 PM" });
  same(first.sources[0] && first.sources[0].freshness, "stale");
  same(first.reviews, []);
  same(first.pinRecipients, []);
} else if (journey === "permanent-code") {
  const native = reports[0];
  const mirror = reports[1];
  const expose = reports[2];
  same(native.pinRecipients, [CLEANER]);
  same(native.sent.filter((text) => text.kind === "pin"), [{ to: CLEANER, body: PIN, kind: "pin" }]);
  same(native.sent.filter((text) => text.kind === "pin-notice"), [{ to: OWNER, body: PIN_NOTICE, kind: "pin-notice" }]);
  if (native.sent.some((text) => text.to === UNAPPROVED || (text.to === OBSERVER && text.kind === "pin"))) fail("the code left the cleaner");
  if (!native.sent.some((text) => text.channel === "group" && text.to === OBSERVER && text.body.startsWith(GROUP + WAIT_OFFER))) {
    fail("the observer did not get a group copy of the offer");
  }
  if (native.sent.some((text) => (text.channel === "group" || text.channel === "mirror") && (text.kind === "pin" || text.body.includes("Door code")))) {
    fail("a group or mirror carried the door code");
  }
  same(mirror.pinRecipients, [CLEANER]);
  same(mirror.sent.filter((text) => text.kind === "pin"), [{ to: CLEANER, body: PIN, kind: "pin" }]);
  if (!mirror.sent.some((text) => text.channel === "mirror" && text.body.startsWith(MIRROR))) fail("the mirror copy was missing");
  if (mirror.sent.some((text) => text.channel === "mirror" && text.body.includes("Door code"))) fail("a mirror copy carried the door code");
  same(expose.sent, [{ to: OWNER, body: EXPOSURE, kind: "review" }]);
  same(expose.reviews.map((item) => item.kind), ["possible-code-exposure"]);
  if ((expose.transcript ?? []).some((line) => line.includes("[redacted]") === false && /\d{4}/.test(line))) fail("the inbound digits were stored");
  same(expose.pinRecipients, []);
} else if (journey === "backup-restore") {
  const court = reports[0];
  const restored = reports[1];
  const courtAgain = reports[2];
  same(court.sent, [{ to: COURT_OWNER, body: COURT_MONDAY, kind: "host-checkout" }]);
  same(court.property, COURT);
  same(restored.sent, []);
  if (!restored.jobs.some((job) => job.id === "stay-anita@guesty.com" && job.textsBlocked === true)) fail("the opt-out did not come back");
  if (!restored.outbox.some((item) => item.kind === "offer" && item.status === "sent")) fail("the offer was lost");
  if (!restored.outbox.some((item) => item.kind === "stop" && item.status === "sent")) fail("the opt-out text was lost");
  same(courtAgain.sent, []);
  same(courtAgain.jobs.map((job) => job.id), ["google:evt-court"]);
  if (JSON.stringify(restored.sent).includes(COURT_OWNER) || JSON.stringify(court.sent).includes(OWNER)) fail("a house texted the other house");
} else if (journey === "no-cleaner") {
  same(first.sent, [
    { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
    { to: OWNER, body: CHECKIN_Q, kind: "host-checkin" },
    { to: OWNER, body: HOLD, kind: "held" },
  ]);
  if (first.sent.some((text) => text.kind === "offer" || text.body.startsWith("Turnover at"))) fail("an offer went out with no opted-in cleaner");
  if (first.jobs.some((job) => job.status === "offered")) fail("a job was offered with no opted-in cleaner");
  same(last.sent, []);
  if (last.outbox.filter((item) => item.body === HOLD && item.status === "sent").length !== 1) fail("the hold note was repeated");
} else if (journey === "replay-no-resend") {
  if (!first.sent.some((text) => text.kind === "offer" && text.to === CLEANER && text.body === OFFER)) fail("the offer did not go to the cleaner");
  if (first.sent.some((text) => text.kind === "offer" && text.to === OWNER)) fail("the offer went to the host");
  same(last.sent, []);
  if (!last.outbox.some((item) => item.kind === "offer" && item.status === "sent")) fail("the offer disappeared");
} else if (journey === "recovery-after-restart") {
  const crashed = reports[0];
  const replay = reports[1];
  const again = reports[2];
  const retried = reports[3];
  const retriedAgain = reports[4];
  const held = reports[5];
  const resumed = reports[6];
  const third = reports[7];
  same(crashed.halted, "after-accept");
  if (crashed.sent.filter((text) => text.kind === "offer").length !== 1) fail("the offer was not accepted once");
  same(replay.sent, [{ to: OWNER, body: UNCERTAIN, kind: "review" }]);
  same(replay.reviews.map((item) => item.kind), ["uncertain-sms"]);
  same(again.sent, []);
  same(retried.sent, [{ to: CLEANER, body: OFFER, kind: "offer" }]);
  if (retried.sent.some((text) => text.to !== CLEANER)) fail("RETRY sent the offer to someone other than the cleaner");
  same(retriedAgain.sent, []);
  same(held.halted, "before-pin");
  if (held.sent.some((text) => text.kind === "pin")) fail("the crash sent the door code");
  same(resumed.sent.filter((text) => text.kind === "pin"), [{ to: CLEANER, body: PIN, kind: "pin" }]);
  same(resumed.pinRecipients, [CLEANER]);
  if (third.sent.some((text) => text.kind === "pin")) fail("the door code was sent again");
} else if (journey === "review-queue") {
  same(first.sent.map((text) => [text.to, text.kind, text.body]), REVIEWS.map(([, body]) => [OWNER, "review", body]));
  same(first.reviews.map((item) => [item.kind, item.status]), REVIEWS.map(([kind]) => [kind, "open"]));
  same(first.health && { ok: first.health.ok, sends: first.health.sends, note: first.health.note, openReviews: first.health.openReviews }, {
    ok: true,
    sends: false,
    note: HEALTH,
    openReviews: REVIEWS.length,
  });
  same(last.sent, [{ to: OWNER, body: AIRBNB, kind: "review" }]);
  same(last.reviews.map((item) => item.kind), ["airbnb-exception"]);
} else if (journey === "observability") {
  same(first.health && { ok: first.health.ok, sends: first.health.sends, note: first.health.note, openReviews: first.health.openReviews, staleSources: first.health.staleSources }, {
    ok: true,
    sends: false,
    note: HEALTH,
    openReviews: 1,
    staleSources: 1,
  });
  if (!first.health.counters || first.health.counters.sent < 1 || first.health.counters.polls < 1) fail("counters were not recorded");
  if (!String(first.health.codeHandling).startsWith("To change the outdoor code at")) fail("the rotation text is missing");
  same(last.ok, true);
  same(last.sends, false);
  same(last.note, HEALTH);
  same(last.openReviews, 1);
  same(last.staleSources, 1);
} else if (journey === "tenant-isolation") {
  const lane = reports[0];
  const court = reports[1];
  const laneRestore = reports[2];
  const laneReplay = reports[3];
  const courtAgain = reports[4];
  const courtReplay = reports[5];
  if (!lane.sent.every((text) => text.to === OWNER || text.to === CLEANER)) fail("Lane texted outside Lane");
  if (!court.sent.every((text) => text.to === COURT_OWNER || text.to === "+15555550111")) fail("Court texted outside Court");
  same(lane.reviews.map((item) => item.kind), ["same-day-capacity"]);
  same(laneRestore.sent, []);
  same(laneRestore.reviews.map((item) => item.kind), ["same-day-capacity"]);
  same(laneReplay.sent, []);
  same(courtAgain.sent, []);
  same(courtAgain.jobs.map((job) => job.id), ["google:evt-court"]);
  same(courtAgain.reviews ?? [], []);
  same(courtReplay.sent, []);
  same(lane.health.openReviews, 1);
  same(courtAgain.health.openReviews, 0);
} else if (journey === "stop-help-injury") {
  const stop = reports[0];
  const help = reports[1];
  const injury = reports[2];
  same(stop.sent, [
    { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
    { to: OWNER, body: STOP_ACK, kind: "stop" },
  ]);
  same(stop.jobs[0].textsBlocked, true);
  same(help.sent, [
    { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
  ]);
  if (help.sent.some((text) => text.kind === "help")) fail("HELP sent a reply");
  same(injury.sent, [
    { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
    { to: OWNER, body: EMERGENCY, kind: "emergency" },
    { to: OWNER, body: HOST_HURT, kind: "emergency" },
    { to: CLEANER, body: CLEANER_HURT, kind: "emergency" },
  ]);
} else if (journey === "observer-injury-group" || journey === "observer-injury-solo") {
  const head = journey === "observer-injury-group"
    ? [
        { to: OWNER, kind: "host-checkout", body: CHECKOUT_Q },
        { to: CLEANER, kind: "opt-in", body: OPT_IN },
        { to: OBSERVER, kind: "opt-in", body: OPT_IN },
      ]
    : [{ to: OWNER, kind: "host-checkout", body: CHECKOUT_Q }];
  same(first.sent.map((text) => ({ to: text.to, kind: text.kind, body: text.body })), [
    ...head,
    { to: OWNER, kind: "emergency", body: OBSERVER_HURT },
    { to: OBSERVER, kind: "emergency", body: CLEANER_HURT },
  ]);
  if (first.sent.some((text) => text.kind === "emergency" && text.channel)) fail("the injury reply was a group or mirror text");
} else if (journey === "owner-injury") {
  same(first.sent.map((text) => ({ to: text.to, kind: text.kind, body: text.body })), [
    { to: OWNER, kind: "host-checkout", body: CHECKOUT_Q },
    { to: OWNER, kind: "emergency", body: EMERGENCY },
  ]);
} else if (journey === "injury-wording") {
  for (const report of reports) {
    const grouped = report.messaging?.actual === "native";
    const head = grouped
      ? [
          { to: OWNER, kind: "host-checkout", body: CHECKOUT_Q },
          { to: CLEANER, kind: "opt-in", body: OPT_IN },
          { to: OBSERVER, kind: "opt-in", body: OPT_IN },
        ]
      : [{ to: OWNER, kind: "host-checkout", body: CHECKOUT_Q }];
    same(report.sent.map((text) => ({ to: text.to, kind: text.kind, body: text.body })), [
      ...head,
      { to: OWNER, kind: "emergency", body: HOST_HURT },
      { to: CLEANER, kind: "emergency", body: CLEANER_HURT },
      { to: OWNER, kind: "emergency", body: OBSERVER_HURT },
      { to: OBSERVER, kind: "emergency", body: CLEANER_HURT },
    ]);
    if (report.sent.some((text) => text.kind === "emergency" && text.channel)) fail("the injury reply was a group or mirror text");
  }
} else if (journey === "ci-local") {
  same(first, { ok: false, reason: "disabled", sent: [], pinRecipients: [] });
} else {
  fail(`unknown journey ${journey}`);
}

if (blob.includes("Door code: ") && !blob.includes("Door code: [redacted]") && !blob.includes("send the door code")) {
  fail("a door code line was not redacted");
}
void OPT_IN;
