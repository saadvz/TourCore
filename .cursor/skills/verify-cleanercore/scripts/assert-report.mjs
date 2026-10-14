#!/usr/bin/env node
// Compare one doctor or smoke stdout file with a literal expected document.
// Fail closed on any phone that is not a Scratch test number.

import { readFileSync } from "node:fs";

const [kind, actualPath, expectedPath] = process.argv.slice(2);
if ((kind !== "doctor" && kind !== "smoke") || !actualPath || !expectedPath) {
  process.stderr.write("Usage: assert-report.mjs doctor|smoke <actual> <expected>\n");
  process.exit(1);
}

const actual = readFileSync(actualPath);
const expected = readFileSync(expectedPath);
if (!actual.equals(expected)) {
  process.stderr.write(`${kind} stdout did not match ${expectedPath}\n`);
  process.exit(1);
}

if (kind === "doctor") {
  const report = JSON.parse(actual.toString("utf8"));
  if (report.sends !== false) {
    process.stderr.write("doctor sends must be false\n");
    process.exit(1);
  }
  process.exit(0);
}

const report = JSON.parse(actual.toString("utf8"));
const phones = [];
for (const text of report.sent ?? []) phones.push(text.to);
for (const to of report.pinRecipients ?? []) phones.push(to);
for (const match of actual.toString("utf8").matchAll(/\+1\d{10}/g)) phones.push(match[0]);

for (const phone of phones) {
  if (!isScratchTestNumber(phone)) {
    process.stderr.write(`Refusing non-Scratch number ${phone}\n`);
    process.exit(1);
  }
}

const pinTexts = (report.sent ?? []).filter((text) => text.kind === "pin");
if (pinTexts.length !== 1 || pinTexts[0].to !== "+15555550101") {
  process.stderr.write("The door code must go only to +15555550101\n");
  process.exit(1);
}
if (!Array.isArray(report.pinRecipients) || report.pinRecipients.length !== 1 || report.pinRecipients[0] !== "+15555550101") {
  process.stderr.write("pinRecipients must be exactly [\"+15555550101\"]\n");
  process.exit(1);
}
for (const text of report.sent ?? []) {
  if (text.kind !== "pin" && String(text.body).includes("4821")) {
    process.stderr.write("The door code leaked into a non-pin text\n");
    process.exit(1);
  }
}

process.exit(0);

function isScratchTestNumber(raw) {
  return /^\+1(?:555\d{7}|\d{3}55501\d{2})$/.test(raw);
}
