import { baselineDrift, buildBaseline, loadBaseline, saveBaseline } from "./baseline";
import { runLive } from "./live";

const command = process.argv[2] ?? "check";
const rebaseline = command === "rebaseline" || process.env.EVAL_REBASELINE === "1";

if (command === "live") {
  const report = await runLive();
  console.log(JSON.stringify(report, null, 2));
  if (report.skipped) console.log(report.reason);
  process.exit(report.ok ? 0 : 1);
}

const report = await buildBaseline();
const headline = `${report.configDiff.differingFieldCount} fields differ across ${report.configDiff.runs} runs`;
const milestoneHeadline = `${report.milestoneDiff.differingFieldCount} fields differ across ${report.milestoneDiff.runs} runs`;
console.log(headline);
console.log(milestoneHeadline);
console.log(report.milestoneMatchesOld ? "Milestone config matches the old-tool canonical config." : "Milestone config does not match the old-tool canonical config.");
for (const task of report.golden) console.log(`${task.passed ? "pass" : "fail"}  ${task.title}  ${task.calls} calls`);

if (rebaseline || command === "rebaseline") {
  saveBaseline(report);
  console.log("Wrote eval/baseline.");
  const diffsClear = report.configDiff.differingFieldCount === 0 && report.milestoneDiff.differingFieldCount === 0 && report.milestoneMatchesOld;
  process.exit(report.golden.every((task) => task.passed) && diffsClear ? 0 : 1);
}

let saved;
try {
  saved = loadBaseline();
} catch {
  console.error("No baseline files in eval/baseline. Run npm run eval:baseline -- rebaseline.");
  process.exit(1);
}
const drift = baselineDrift(report, saved);
if (drift) {
  console.error(drift);
  process.exit(1);
}
if (report.configDiff.differingFieldCount !== 0 || report.milestoneDiff.differingFieldCount !== 0 || !report.milestoneMatchesOld) {
  console.error("Duplex config diff is not zero.");
  process.exit(1);
}
console.log("Baseline matches.");
