#!/usr/bin/env node
// Compare one doctor or smoke stdout file with a literal expected document.
// Fail closed on any phone that is not a Scratch test number.

import { readFileSync } from "node:fs";

const [kind, actualPath, expectedPath, pinMode = "required"] = process.argv.slice(2);
if ((kind !== "doctor" && kind !== "smoke") || !actualPath || !expectedPath || (pinMode !== "required" && pinMode !== "forbidden")) {
  process.stderr.write("Usage: assert-report.mjs doctor|smoke <actual> <expected> [required|forbidden]\n");
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

const allowedRecipients = new Set(["+15555550100", "+15555550101"]);
for (const text of report.sent ?? []) {
  if (!allowedRecipients.has(text.to)) {
    process.stderr.write(`Refusing recipient ${text.to}\n`);
    process.exit(1);
  }
}
for (const to of report.pinRecipients ?? []) {
  if (!allowedRecipients.has(to)) {
    process.stderr.write(`Refusing pin recipient ${to}\n`);
    process.exit(1);
  }
}

const raw = actual.toString("utf8");
if ((report.sent ?? []).some((text) => text.kind === "pin") || (report.pinRecipients ?? []).length !== 0) {
  process.stderr.write("Step C must not send a door code\n");
  process.exit(1);
}
if (raw.includes("4821") || raw.toLowerCase().includes("door code")) {
  process.stderr.write("The door code leaked into the smoke report\n");
  process.exit(1);
}
if (pinMode === "required") {
  process.stderr.write("Step C has no door-code send to require\n");
  process.exit(1);
}

process.exit(0);

function isScratchTestNumber(raw) {
  return /^\+1(?:555\d{7}|\d{3}55501\d{2})$/.test(raw);
}
