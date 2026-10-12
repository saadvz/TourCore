# Phase 0.4: decision and drafting model evaluation

Status: **architecture decision finalized by the user, 12 October 2026**.
The dataset, offline scoring and measured rules/template baselines are ready.
Three small Decision 3.0 variants have now been measured
locally on native screening tasks, and Microsoft and Perplexity have completed
the same hosted screening. One small generator was measured separately and
failed the host-review wording fixtures. The connected Grok static comparison
is now scored from user-uploaded predictions. Complete architecture,
multi-turn, independent review and cost comparisons remain pending as
production validation, not prerequisites to the retained-architecture decision.
No new inference dependency is selected for production.

The user added the [vLLM Semantic Router Decision 3.0 collection](https://huggingface.co/collections/vllm-sr/decision-30)
to the roadmap's Microsoft Decision-1, Perplexity Decider, rules-first and
connected-agent comparison. Its exact model cards and metadata are now
accessible and recorded; no earlier release was substituted.

## Final architecture decision

- **Keep** existing deterministic rules, scheduling constraints, access
  policies and operational reply templates.
- **Prioritize Grok Bot** as the first agent delegation client, with an
  engine-owned fallback. Keep the delegation contract agent-agnostic so other
  landlord-owned clients can implement the same scoped interface.
- **Continue evaluating Perplexity Decider V1.1** as an optional classification
  service. It is not a required runtime dependency or authorized live integration.
- **Do not integrate yet** Microsoft Decision-1, the tested small Decision 3.0
  variants, or Qwen3.5-0.8B as a production SMS reply generator. This decision
  concerns the tested configurations; larger Decision 3.0 variants remain unrun.

The evaluation does not justify a complicated inference stack inside Tour Core.
Keep the engine inexpensive and agent-agnostic; delegate as much intelligence
and work as possible to the landlord's existing AI agent within the engine's
authorization and validation contract. Add an inference bill only when measured
data demonstrates a real need and a complete architecture improves reliability.
Actual multi-tenant operating economics still require Phase 0.5 evidence.

The next investment is reliable autonomous execution. The
[existing execution proof](cleaner-agent-execution-decision.md) already supports
unattended webhook/MCP execution, duplicate handling, deadline fallback, a
20-request sample and one real SMS trial in the isolated prototype. Build on
that evidence with checks for runtime/engine restart,
credential revocation and capability expiry, concurrent claims and stale
actions, lost provider acknowledgments and reconciliation, tenant isolation,
and per-tenant budgets. Existing controlled tests for several of these paths
are not live agent/provider reliability guarantees. This decision does not
promote the prototype to production-ready or change its supported scope.

## Shared evaluation and current results

The [reusable evaluation artifacts](../eval/cleaner-phase04/README.md) contain
120 synthetic SMS cases, labeled before the baseline was executed, across
ten equally sized categories: arrived, approaching, contextual replies,
conflicting/unclear messages, rescheduling/dates, combined questions, access
problems, menu selections, property questions and untrusted instructions.
Contexts include pending confirmations and grounded menus. These are
preliminary author labels, not independent human labels or a production
holdout; common phrases overlap existing regression examples.

The baseline calls the actual `interpretByRules`, without a model or live
workflow. Gold labels were retained after observing failures. The
[saved report](../eval/cleaner-phase04/results/rules-first-report.json) records:

| Metric | Measured baseline |
| --- | --- |
| Intent-type accuracy | 111/120 = 92.5% |
| Intent, required entities and abstention decision correct | 110/120 = 91.7% |
| Schema-valid interpretations | 120/120 |
| Abstention behavior correct | 118/120 = 98.3% |
| Effective clarification/abstention rate | 39/120 = 32.5% |
| Explicit clarification-needed flag | 18/120 = 15.0% |
| Raw false-positive access intents | 6/106 negative-access cases |
| Access false positives above the existing confidence threshold | 1/106 = 0.94% |
| Local interpretation latency P50 / P95 | 0.136 ms / 0.973 ms |
| Inference API calls / marginal inference spend | 0 / $0 |

Latency is one local function invocation per message, including first-call
effects but excluding import/startup, transport, engine execution, provider
delivery and human response. Local CPU/hosting cost was not measured. This
cannot be directly compared with a remote model's network latency or the
earlier unattended SMS completion measurements.

The actionable false-positive case is `p04_023`:

> I'm here at work, not at the apartment

It returned `ARRIVAL` with confidence 0.95. The preliminary gold label requires
abstention because the speaker explicitly denies property presence. This is an
interpreter finding; no access action or full visitor state-machine execution
was performed. Existing engine authorization still governs any real effect.
Other misses include plural arrival phrasing, a rent question combined with
a time choice, a stuck entrance classified as being lost, and a request for a
person classified as a property question. Low-confidence access labels often
abstained correctly even when their raw label differed from `UNKNOWN`.

The actual `LayeredIntentInterpreter` treats a confident rules result as final.
Consequently, adding a model only on its existing semantic-fallback path cannot
repair the confident `p04_023` classification. Compare candidate-only decisions
and the real rules-first integration separately. Any proposal to verify
high-confidence access interpretations must be evaluated as a distinct routing
change, with its additional call cost/latency; it is not implemented here.

The separate [24 draft fixtures](../eval/cleaner-phase04/draft-cases.json)
cover future/expired times, start/end boundaries, duration overruns and two
time zones. The baseline uses the actual delegation engine to select a valid
proposal or its deterministic deadline template in temporary storage, then
reads the saved draft without invoking the send worker. It achieved 24/24
correct scheduling decisions and 24/24 required-fact checks. Its deadline
clock is advanced artificially; the local draft timing does not measure a
real timeout. Independent human semantic reviews remain pending; the separate
generator wording screen below does not replace them.
Regex/fact checks alone do not establish safety or correct meaning.

## Candidate identity and inference research

| Candidate | Evidence available here | Remaining prerequisite |
| --- | --- | --- |
| Rules-first interpreter | Measured directly against the frozen synthetic cases | Independent labels and representative production messages |
| Connected Grok | 120 closed-book SMS + 24 scheduling/draft predictions scored; earlier workflow/capability evidence | Measured per-case timing/cost, independent review and separate evolving multi-turn/native-tool exercises |
| Microsoft Decision 1 | Actual 120 intent + 24 constraint calls through OpenRouter native Decisions API | Full entities/abstention/generation architecture and independent holdout |
| Perplexity Decider | Actual 120 intent + 24 constraint calls; v1.1 HF card is Apache-2.0 | Full architecture and independent holdout; local full checkpoint exceeds memory budget |
| vLLM-SR Decision 3.0 | Exact collection/cards verified; `d3-edge`, `d3-lite`, `d3-nano` benchmarked locally | Larger variants, extracted entities, generated replies and live workflows remain untested |
| Shared small generator | Pinned Apache-2.0 Qwen3.5-0.8B measured on 24 engine-approved wording fixtures | Current prompt failed; retain templates and evaluate any new generator/prompt on a new version |

The official vLLM project's earlier models support application-defined
`choice`, `noul` and `score` questions. They return selected options and
probabilities under a native decision interface. They can therefore be
relevant to SMS classification rather than merely embedding-based domain
routing. Those earlier-source observations preceded the direct 3.0 inspection
recorded below. Native decision output is
not assumed to be a generated JSON chat answer or a reply draft.

The official example describes System One-shaped state/questions and a
separately deployed HTTP endpoint; downloading weights does not create an
endpoint. Its earlier compact encoder models list a 1,024-token total input
budget, whereas larger earlier variants list longer budgets. Verify the
**selected 3.0 card**, including the entire state/question/choice budget;
do not carry those earlier limits forward as 3.0 facts.

For Perplexity, Baseten's specific v1 deployment example uses an H100 and 80Gi
memory. This is an example, not a universal minimum or a cost measurement.
The current environment has no GPU. CPU PyTorch/Transformers were subsequently
installed in a separate benchmark environment. Hosted API testing lets us keep
this development environment while
avoiding provisioning a model server. A self-hosted candidate would need a
separate, appropriately sized inference service. Do not deploy a large model
onto the small always-on Cleaner Core test service.

Sources were read from these pinned public GitHub revisions:

- [Official vLLM Decision model guide](https://github.com/vllm-project/semantic-router/blob/692ff7558e909bda5a6b39585c97f0af91543b37/website/docs/model-runtime/guides/decisions.md)
  and [earlier release explanation](https://github.com/vllm-project/semantic-router/blob/692ff7558e909bda5a6b39585c97f0af91543b37/website/blog/2026-09-22-introduce-decision.md).
- [Decision Bench model configuration](https://github.com/atlanai/decision-bench/blob/57cee31bbcc8dfa27f8b22de7fb8e2a32b2a379c/config/models.json)
  and [native OpenRouter adapter](https://github.com/atlanai/decision-bench/blob/57cee31bbcc8dfa27f8b22de7fb8e2a32b2a379c/decision_bench/openrouter_decisions.py).
  These are secondary published configurations, not current provider metadata
  verified in this environment. Their external benchmark scores/prices are
  not copied into our results.
- [Baseten Perplexity v1 deployment example](https://github.com/basetenlabs/truss-examples/blob/80a3a70610c1d1d1c93ab05c66e36396bb7662be/11-embeddings-reranker-classification-tensorrt/BEI-Bert-perplexity-ai-pplx-decider-v1-27b/config.yaml).
  This is deployment-provider documentation, not a verified weights license.

Exact access/research status, source identity and unknown per-message costs are
preserved in [the candidate registry](../eval/cleaner-phase04/candidates.json).

## Direct inspection and measured Decision 3.0 screening

After the user published the network settings, Hugging Face and the OpenRouter
API/documentation became accessible. The filtered
[primary-source catalog record](evidence/cleaner-model-catalog-2026-10-11.json)
includes exact collection membership, revisions, license fields and current
hosted metadata. All six model cards declare Apache-2.0 and native Choice,
Yes/No and Score decisions over text/JSON, with image/video capabilities.
Only text was tested here.

| Collection artifact | Parameters including vision | Local evaluation |
| --- | ---: | --- |
| `vllm-sr/d3-edge` | 0.59B | Completed |
| `vllm-sr/d3-lite` | 0.85B | Completed |
| `vllm-sr/d3-nano` | 2.21B | Completed |
| `vllm-sr/d3-mini` | 4.54B | Not run |
| `vllm-sr/d3-flash` | 8.39B | Not run |
| `vllm-sr/d3` | 26.09B | Not run |

Hugging Face lists no hosted inference providers for these collection entries.
The largest checkpoint's BF16 weights alone exceed the environment's 32 GiB
memory limit. Three small variants were tested using the official CPU reference
path: four CPU threads, BF16 backbone, FP32 readout, PyTorch 2.14.1 and
Transformers 5.17.0. The pinned package manifest and every file hash were checked
before executing the inspected runtime code. GPU-only acceleration was omitted
as documented; checkpoint numerics and attention behavior were preserved.

Each model received the same frozen `native-questions.json` and label-free
packet. There were 120 sequential intent-type calls and 24 sequential
structured scheduling-constraint calls per variant: **432 model calls total,
with no runtime failures**. Native stages exclude required entity extraction,
generated reply text, actual tools and live SMS. The table's rule figure is
intent-type accuracy, not the earlier 91.7% complete intent/entity result.

| Arm | Intent types correct | Raw access false positives / 106 | Local intent P50 / P95 | Constraint decisions correct / 24 |
| --- | ---: | ---: | --- | ---: |
| Rules / deterministic engine | 111/120 (92.5%) | 6 | 0.136 / 0.973 ms | 24 |
| `d3-edge` | 62/120 (51.7%) | 2 | 1.389 / 1.660 s | 14 |
| `d3-lite` | 81/120 (67.5%) | 13 | 3.078 / 3.732 s | 14 |
| `d3-nano` | 80/120 (66.7%) | 18 | 5.443 / 6.371 s | 16 |

Raw false positives count the label before confidence/clarification gating.
They are distinct from the rules' one above-threshold false positive. Native
confidence is not directly comparable: the inspected 3.0 runtime computes
**one minus normalized entropy**, while selected probability is a separate
value. Both are saved without renormalizing or converting them into a claim of
calibrated correctness. `UNKNOWN` label rates and selected-probability Brier
scores are diagnostic fields, not production clarification/calibration proof.

These runs do not support replacing the rules with the tested variants under
this prompt. This does not reject larger variants, alternative prompts or a
different task; those are unmeasured. Prompt/label tuning would require a new
version and matched reruns, followed by an independent holdout. Scheduling
constraints remain an engine responsibility regardless of a model's verdict.

The actual API spend for local runs was zero; infrastructure cost is unknown.
Native call timing includes formatting/tokenization/CPU forward/decoding and
excludes checkpoint loading and SMS. Published GPU latencies were not used as
our measurements. Raw predictions and reports are in
[`eval/cleaner-phase04/results/`](../eval/cleaner-phase04/results/).

Current OpenRouter primary metadata lists Microsoft at **$0.042 per million
input tokens** and Perplexity V1.1 at **$0.020**, with zero output-token price for
these native decisions. This is advertised pricing, not actual per-message
receipts. Use `GET /api/v1/models?output_modalities=decisions`: the default list
contains text-output models and omits native decisions. Both use the documented
`POST /api/alpha/decisions` interface. The helper is prepared with a shared
question specification, bounded spend, no automatic retries/redirects and a
secure key binding. Authenticated vendor inference was then completed below.

## Hosted screening and generator wording results

The user published a secure `OPENROUTER_API_KEY` binding. All four hosted runs
used the same frozen native questions, inputs and preliminary labels as the
local variants. There were **288 actual hosted inference calls**, all with
valid native choices/probabilities and provider-reported costs. One read-only
key-info request returned HTTP 401 before inference; a fresh read-only check
and a new run succeeded. It is excluded from per-case timings and was not a
paid retry. Each run had a $0.05 local spend ceiling ($0.20 combined). The key's
actual account limit was $100; it was not represented as a $1 provider cap.
Actual total native inference spend was **$0.006820102**.

| Candidate | Intent correct / 120 | Raw access false positives / 106 | UNKNOWN labels | Intent HTTPS P50 / P95 | Actual mean intent API cost | Constraints correct / 24 |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| Microsoft Decision-1 | 100 (83.3%) | 8 | 17.5% | 297 / 345 ms | $0.00003310825 | 24 |
| Perplexity Decider V1.1 | 115 (95.8%) | 0 | 28.3% | 338 / 474 ms | $0.00001944967 | 18 |

UNKNOWN-label rate is not complete clarification/abstention behavior. These
native heads do not return all grounded intent entities or generated drafts.
The per-message API costs cover native decisions only. Microsoft constraints
cost $0.000323232 total, Perplexity constraints $0.000189920 total. HTTPS timings
include transport/provider inference and exclude startup, metadata reads,
generation, engine actions and SMS; they are not the local rules timing scope.

The [paired type-only comparison](../eval/cleaner-phase04/results/native-comparison.json)
records Perplexity fixing nine rule misses while losing five rule-correct
cases. Its five misses are conflicting replies (`p04_038`, `039`, `041`, `045`,
`048`). The exact two-sided McNemar value is 0.424 on these preliminary labels;
this small synthetic sample does not establish a reliable production gain.
Its zero raw access false positives are promising, but scheduling was wrong
on six fixtures and must remain deterministically validated. Microsoft fixes
eight rule misses but loses nineteen rule-correct cases, so it does not support
a replacement under this prompt. None of the three tested Decision 3.0 sizes
improved aggregate type accuracy over rules.

For a separate generator-component screen, **Qwen/Qwen3.5-0.8B** was pinned at
`2fc06364715b967f1860aea9cf38778875588b17`, Apache-2.0. Every selected artifact
was checked against public LFS SHA-256 or Git blob SHA-1 metadata before stock
Transformers execution with `trust_remote_code=False`; see the
[artifact record](evidence/cleaner-generator-artifact-2026-10-11.json).
The prompt was fixed before generation: greedy decoding, thinking disabled,
128 new-token limit, CPU BF16 and four threads. Inputs contained actual engine
baseline decisions and formatted times, not gold rationale or template text.

All 24 drafts were generated without errors or hitting the token limit. Only
**10/24** passed required-fact checks. All fourteen host-review cases instead
said cleaning was scheduled at the requested time, contradicting the supplied
engine decision. No prohibited access pattern was flagged, but that does not
make the replies correct. Generator P50/P95 was 3.352/3.898 seconds; inference
API spend was zero and infrastructure cost is unmeasured. Its copied decision
field is an engine input, not generator decision accuracy. Independent human
semantic reviews are pending, and no paired full classifier/extractor/generator
architecture or real SMS action was run. Retain deterministic reply templates.

The native screening supports keeping the existing rules and engine templates.
Perplexity is the only native candidate worth a further classification
comparison on these results, not a selected production dependency. A new
generator prompt would be a new experiment with matched reruns; these failures
were preserved.

## Connected Grok static evaluation, 12 October 2026

The user returned both prediction files from the standalone closed-book
packet. The original bytes were retained, their dataset hashes and all case
IDs validated, and the existing scorers were used without changing labels or
acceptance patterns. [Provenance and file hashes](evidence/cleaner-grok-evaluation-2026-10-12.json)
record the reported in-chat reasoning/local-file-writing method. Model/version
was not exposed. Closed-book compliance and absence of application calls are
agent-reported; this workspace did not independently trace that execution.
`manipulation` is correctly located at `interpretation.manipulation`, alongside
`intent`, as the existing scorer and application interpretation support.

| Metric | Grok static packet | Rules baseline |
| --- | ---: | ---: |
| Intent labels correct | 115/120 (95.8%) | 111/120 (92.5%) |
| Intent, required entities and abstention decision correct | 115/120 (95.8%) | 110/120 (91.7%) |
| Schema-valid interpretations | 120/120 | 120/120 |
| Abstention behavior correct | 115/120 | 118/120 |
| Effective clarification/abstention rate | 44/120 (36.7%) | 39/120 (32.5%) |
| Explicit clarification-needed flag | 17/120 (14.2%) | 18/120 (15.0%) |
| Raw access false positives / 106 negative cases | 0 | 6 |
| Access false positives above existing engine thresholds | 0 | 1 |
| Per-case inference P50/P95 and provider cost | Unmeasured | Local timing/API spend reported above |

All five full-interpretation misses (`p04_061`, `062`, `063`, `064`, `066`)
contain both a property question and a requested time. Grok prioritized the
time rather than the question, and its low confidence caused engine abstention.
The frozen gold expects the property-question intent. The existing application
supports retaining a mentioned time alongside that intent for subsequent
confirmation; no interpreter or prompt was changed here. All twelve untrusted
instruction cases were UNKNOWN with manipulation flagged. There were 39 UNKNOWN
labels; effective abstention also includes five low-confidence specific labels.

The [paired full-interpretation comparison](../eval/cleaner-phase04/results/grok-rules-comparison.json)
shows nine wins and four losses against rules, a +4.17 percentage-point
diagnostic gain. Its exact two-sided McNemar value is 0.267, not production
significance. Grok and Perplexity both reach 115/120 label accuracy but on
different errors: Grok's are mixed question/time messages, Perplexity's are
conflicting replies. Perplexity's native heads were not scored as full grounded
intent/entity/abstention outputs, so the complete-output figure is not shared.

Grok chose the correct scheduling decision on **24/24** fixtures (ten proposals,
fourteen host reviews). All drafts mention host clearance and no prohibited
access pattern was flagged. The frozen strict required-fact score is **0/24**:
proposal dates use `Tue Oct 13, 10:00 AM EDT` rather than the canonical label or
ISO string, and host reviews use `current time ... stays unchanged` rather than
the accepted `existing time ... unchanged` pattern. This is preserved as a
literal-check failure, not represented as 24 incorrect scheduling decisions.

A [separate supplemental fact inspection](../eval/cleaner-phase04/results/grok-draft-supplemental-review.json)
verified every requested local date/time/EDT-or-BST literal, each host review's
unchanged confirmed time and every clearance statement. This inspection was
written after observing the wording; it is not a replacement comparable scorer
or an independent human semantic review. Years are omitted in draft text and
inferred from fixture context. Proposal drafts add `pending confirmation` and
say nothing has changed yet. The packet does not specify a post-commit delivery
stage, so this cannot establish compatibility with the live engine's completion
messages; wording must be checked against that stage before deployment.

The reported 01:17:06–01:17:41 AM America/New_York interval is a **35-second
batch duration**, from opening the packet to saving files. It is not per-case
model latency or end-to-end request latency. Every per-case latency and cost
remains `null`. No new action-tool/SMS/booking operation was performed to score
these files. Static contexts do not prove evolving multi-turn behavior, native
tool execution or the cheapest complete architecture.

Final user architecture decision: retain deterministic scheduling, access policy
and reply templates; retain the already-supported optional Grok adapter with
engine-owned fallback. Do not add a required decision-model/generator service
on this evidence. Prioritize Grok as the first delegation client and continue
evaluating Perplexity as optional classification. Unresolved combined-message
behavior, unknown Grok economics and missing complete-architecture checks
remain validation limits; they do not authorize replacing deterministic controls.

## Comparison protocol and model decision

1. Independently review preliminary labels and add representative anonymized
   messages before drawing production conclusions. Preserve a genuinely
   unseen holdout; do not tune prompts/thresholds on reported evaluation rows.
2. Verify candidate identity, revision, licensing/terms, supported inference
   interface, current price and deployment resources. Candidate selection
   within Decision 3.0 should be driven by the cards, then measured quality
   and cost. Do not guess a model ID from the collection URL.
3. Export label-free task packets. Run every arm against the same messages and
   engine context, with no access to gold labels or other candidates' results.
   Fix native question descriptions and schema mappings before comparing.
   Preserve raw probabilities; do not invent confidence for an argmax label.
4. For native Choice models, separately ground required entities/time fields
   using permitted context or a documented extraction stage. Report label
   accuracy separately from complete pipeline accuracy. Charge all extraction,
   classification, generation, retries and network time to that arm.
5. Evaluate controlled reply drafts with the same generator/prompt for each
   decision-model arm. Review meaning, unsupported facts and access implications
   independently; automated wording checks are only supplementary.
6. Report paired accuracy changes, false-positive access intents, clarification,
   malformed/failed outputs, P50/P95 latency and provider-reported per-message
   costs. `null` means unknown. Measure cold/warm and retry effects separately;
   amortize an always-on self-hosted model's actual cost rather than claiming
   inference is free because the weights are downloadable.
7. Exercise evolving multi-turn context and scoped native reads separately
   before crediting connected-agent workflow accuracy. Static contexts and
   prior successful SMS trials do not establish those results.

A candidate must materially improve measured reliability without increasing
actionable access mistakes or silently altering deterministic commands/policy.
Confidence calibration, malformed-output fallback and deadline adherence must
be evaluated for the proposed integration, not inferred from model benchmarks.
Compare matched correctness and inspect every consequential error; the scorer
provides a paired McNemar calculation, but this synthetic set cannot establish
independent production significance. The minimum useful gain and operational
latency/cost budget must be set before a production holdout evaluation.

Select the least expensive **complete architecture** that meets those criteria.
If no candidate does, retain deterministic rules and authorized clarification
or review. Models remain optional. Access and consequential housing decisions
remain under engine rules and authorized review, as specified by the
[Phase 0.3 contract](cleaner-engine-agent-contract.md).

## Remaining work and next action

The earlier proxy CONNECT 403 was resolved after the user saved/published
unrestricted Internet settings. Direct collection, model-card and primary
provider metadata reads returned HTTP 200. Network access is now verified.

The saved, reviewed setup draft records CPU dependencies, reusable checkpoint
commands and the supported secret requirement. Native local and authenticated
hosted inference are verified. Publication of the latest draft/snapshot is a
separate environment-settings step and has not been independently confirmed.
No new SMS or external booking action occurred.

The connected-agent static packet has been returned and scored. No further
API setup or model calls are needed to preserve this diagnostic comparison.
Before a production replacement, complete grounded native-model pipelines,
measure connected-agent inference latency/cost, exercise evolving multi-turn
context/native reads and independently review labels and draft meaning. Static
native screening and a generator-component test do not establish a complete
model architecture or justify wiring a candidate into live authorization.

The offline scorer and exporters were exercised, including rejection of bad
hashes, missing/duplicate cases and invalid results. Baseline metrics were
independently recomputed from the saved predictions. The Phase 0.4 architecture
decision is now finalized. Further candidate evaluation is optional; production
validation remains open. Keep models optional and existing deterministic controls
authoritative, with the next implementation investment in autonomous execution
reliability and the roadmap's Phase 0.5 tenant-isolation/economics proof.
