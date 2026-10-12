# Phase 0.4 diagnostic evaluation artifacts

Run from `/workspace/TourCore` with the already-installed dependencies:

```sh
node --import tsx eval/cleaner-phase04/run.mjs baseline
node --import tsx eval/cleaner-phase04/run.mjs draft-baseline
node --import tsx eval/cleaner-phase04/run.mjs export /tmp/phase04-sms-tasks.json
node --import tsx eval/cleaner-phase04/run.mjs export-drafts /tmp/phase04-draft-tasks.json
```

The first two commands overwrite only these benchmark's generated results.
They call existing rules and the local delegation engine. No service starts,
model API is called, SMS is sent or live booking is read/changed. Draft fixtures
use temporary storage removed after each case and an injected clock; the send
worker is never invoked.

`sms-cases.json` contains 120 synthetic, preliminary author-labeled messages,
frozen before baseline execution. `draft-cases.json` adds 24 scheduling/draft
fixtures. Some common phrases overlap existing regression examples. Every
case is diagnostic: there is no independent held-out production set yet.
Review disputed labels independently, record corrections as a new dataset
version, and rerun every candidate on that version. Do not tune labels to make
an observed result pass.

Candidate input exports omit gold labels and rationale. Give the exported
task packet to an isolated, closed-book model/agent run; do not supply the
scored results or permit reads of the gold file. Capture a complete prediction
file in the format described by the export. Include exact model/revision,
adapter/prompt, raw probabilities when available, transport, measured request
latency and provider-reported cost. Unknown cost/latency is `null`, not zero.
For native decision models, an adapter must use their supported decision
interface and ground entity choices; a chat-completions endpoint is not assumed.

Score and compare completed runs:

```sh
node --import tsx eval/cleaner-phase04/run.mjs score /tmp/candidate-sms-predictions.json /tmp/candidate-sms-report.json
node --import tsx eval/cleaner-phase04/run.mjs score-drafts /tmp/candidate-draft-predictions.json /tmp/candidate-draft-report.json
node --import tsx eval/cleaner-phase04/run.mjs compare eval/cleaner-phase04/results/rules-first-report.json /tmp/candidate-sms-report.json /tmp/paired-comparison.json
```

The scorer rejects a changed dataset hash, missing cases or duplicate IDs.
Failed requests and schema-invalid interpretations do not become correct
`UNKNOWN` answers. Intent-type accuracy is distinct from full intent/entity
validity and the confidence/abstention decision. A type-only classifier can
score on labels but cannot pass the complete pipeline without grounded
entities. Access false positives are reported both before and after Tour
Core's fixed confidence thresholds; neither metric executes access policy.

Clarification/abstention rate includes low-confidence/unknown interpretations;
the explicit `clarificationNeeded` flag rate is reported separately. Latency
uses nearest-rank P50/P95. Compare identical timing scopes: local function
timing is not a remote model's network time or real SMS end-to-end latency.
The paired comparison reports wins/losses and an exact two-sided McNemar test,
with no production significance claim for these preliminary labels.

Draft checks cover the structured scheduling decision, required time/unchanged
facts and host-clearance wording. Text matching and prohibited-claim patterns
are diagnostic only; all drafts still need independent semantic review.
Classification plus generation latency/cost must include both stages. Calendar
integration, evolving multi-turn conversation and live action reliability are
not measured by these packets.

See [the Phase 0.4 record](../../docs/cleaner-model-evaluation.md) for actual
baseline numbers, model research, pending access and acceptance criteria.
`candidates.json` keeps unrun candidates and unknown costs explicit.
