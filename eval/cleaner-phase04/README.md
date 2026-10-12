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

## Native Decision 3.0 screening

An isolated Python environment is prepared at
`/workspace/cleaner-phase04-venv`. It uses CPU PyTorch 2.14.1, Transformers
5.17.0 and the public Apache-2.0 `d3-edge`, `d3-lite` and `d3-nano`
checkpoints. Weights and runtime code are pinned; the preparer and runner check
every manifest file with SHA-256. GPU-only FLA kernels are omitted for the
documented CPU reference path. Models/caches live outside the Git checkout.

```sh
HF_HOME=/workspace/cleaner-phase04-hf-cache /workspace/cleaner-phase04-venv/bin/python eval/cleaner-phase04/prepare_native_models.py
node --import tsx eval/cleaner-phase04/run.mjs export /workspace/cleaner-phase04-sms-tasks.json
node --import tsx eval/cleaner-phase04/run.mjs export-drafts /workspace/cleaner-phase04-draft-tasks.json

/workspace/cleaner-phase04-venv/bin/python eval/cleaner-phase04/native_runner.py --transport local --model d3-edge --kind intent --tasks /workspace/cleaner-phase04-sms-tasks.json --output eval/cleaner-phase04/results/d3-edge-intent-screen.json --resume
/workspace/cleaner-phase04-venv/bin/python eval/cleaner-phase04/score_native.py --input eval/cleaner-phase04/results/d3-edge-intent-screen.json --output eval/cleaner-phase04/results/d3-edge-intent-report.json --kind intent
```

Use `d3-lite` or `d3-nano` for the other inspected variants. For the 24
constraint cases, use `--kind constraint` with the draft task packet and
distinct output files. The native runs perform one sequential call per case;
do not run several local models concurrently when measuring latency. A resume
requires the same task, model and question hashes. It saves each completed row
before moving on. All three variants completed 120 intent cases and 24
constraint cases without runtime errors.

These are **label/constraint screening results**, distinct from the complete
intent/entity/abstention and generated-draft reports. Native models do not
generate replies. The frozen `native-questions.json` specification is shared
across candidate transports. Both native confidence and selected probability
are retained; Decision 3.0's native confidence is one minus normalized entropy,
not calibrated correctness. No native result is wired into access authorization.
Draft exports also omit scenario names, which would imply the expected verdict.

## Hosted Microsoft and Perplexity access

One OpenRouter key supports the two currently listed native decision models.
Create it at [OpenRouter keys](https://openrouter.ai/settings/keys), with a
**$1 credit limit**. Store only the bare key in this environment's supported
Network secrets binding named `OPENROUTER_API_KEY`, restricted to
`openrouter.ai`. The runner adds the bearer prefix itself. Save/publish the
environment changes and verify the binding becomes available; never paste it
into chat, an input packet, a script or Git. Account credits may be needed;
creating a key alone does not prove paid inference access.

Authenticated inference completed 120 intent and 24 constraint calls for each
hosted model. The combined provider-reported native API charge was $0.006820102.
The following is a repeatable run command (repeating it spends additional
credits; preserve existing evidence and use a new output path):

```sh
/workspace/cleaner-phase04-venv/bin/python eval/cleaner-phase04/native_runner.py --transport openrouter --model microsoft/microsoft-decision-1 --kind intent --tasks /workspace/cleaner-phase04-sms-tasks.json --output /tmp/new-microsoft-intent-screen.json --max-api-spend-usd 0.05
```

Use `perplexity/pplx-decider-v1.1-27b` with its own output file for Perplexity.
The runner discovers current decision-model pricing, checks the key's credit
cap through the documented key-info endpoint, refuses redirects, performs no
automatic retries and retains provider-reported costs. Missing/uncertain cost
stops subsequent paid calls. A $1 key limit remains recommended; the configured
key actually has a $100 limit, so these four runs used local $0.05 ceilings,
$0.20 combined. The helper permits a larger positive account cap while bounding
each run to at most $1 locally. Do not restart a partially billed run blindly.
The HTTP transport, malformed-response behavior and budgets were checked with
controlled local fixtures; those checks are not real vendor trial results.

## Generator component and connected-agent packet

`generator_runner.py` checks a pinned Apache-2.0 Qwen3.5-0.8B checkpoint against
public file metadata. It loads only stock Transformers code, no custom model
code. `generator-facts.json` freezes actual engine baseline decisions and
formatted times; it supplies no gold rationale or template wording. Its scope
is wording only. The 24 measured drafts passed 10 required-fact checks and
misstated all 14 host-review cases as scheduled; retain the engine templates.

```sh
HF_HOME=/workspace/cleaner-phase04-hf-cache /workspace/cleaner-phase04-venv/bin/python eval/cleaner-phase04/generator_runner.py --tasks eval/cleaner-phase04/generator-facts.json --output /tmp/new-generator-wording.json
/workspace/cleaner-phase04-venv/bin/python eval/cleaner-phase04/score_generator.py --input eval/cleaner-phase04/results/qwen-generator-wording.json --output /tmp/generator-report.json
```

Generation timings exclude engine decisions and model loading. These are
component tests, not measured complete decision-model-plus-generator arms.
API spend is zero locally; CPU hosting cost and independent semantic reviews
remain unmeasured. Do not tune this prompt based on failures without recording
a new experiment and matched reruns.

[Connected-agent instructions](connected-agent-instructions.md) and the two
`connected-agent-*-tasks.json` files provide a closed-book packet for Grok. Give
it only those task files and instructions, excluding this repository/reports.
Return prediction JSON for the existing scorers. Static packets do not measure
evolving multi-turn behavior or native tool actions; those remain separate.
