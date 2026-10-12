# Phase 0.4: decision and drafting model evaluation

Status: **partial**. The dataset, offline scoring and measured rules/template
baselines are ready. No candidate model has been run on this dataset, no model
ranking is established, and no inference provider has been selected.

The user added the [vLLM Semantic Router Decision 3.0 collection](https://huggingface.co/collections/vllm-sr/decision-30)
to the roadmap's Microsoft Decision-1, Perplexity Decider, rules-first and
connected-agent comparison. The exact collection remains a required candidate;
earlier Decision releases are not substituted for it.

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
real timeout. No semantic reviews or generated-model drafts were performed.
Regex/fact checks alone do not establish safety or correct meaning.

## Candidate identity and inference research

| Candidate | Evidence available here | Remaining prerequisite |
| --- | --- | --- |
| Rules-first interpreter | Measured directly against the frozen synthetic cases | Independent labels and representative production messages |
| Connected Grok | Earlier verified workflow/capability evidence; user has a connected account | Closed-book predictions on these exact cases, measured timing/cost and separate multi-turn/native-tool exercises |
| Microsoft Decision 1 | A published benchmark configuration names `microsoft/microsoft-decision-1` through OpenRouter native Decisions | Verify current provider metadata/terms and obtain supported inference access |
| Perplexity Decider | Published hosted config names `perplexity/pplx-decider-v1.1-27b`; Baseten also supplies a self-hosted **v1** example | Verify current hosted metadata and distinguish v1.1 from the v1 weights; obtain inference access |
| vLLM-SR Decision 3.0 | User's requested collection; related official project docs describe earlier general decision models | Read exact collection/model cards, pin suitable artifact/revision, verify license and deploy or locate a supported endpoint |
| Shared small generator | Not selected | Pick a supported generator and hold model/version/prompt fixed across decision-model arms |

The official vLLM project's earlier models support application-defined
`choice`, `noul` and `score` questions. They return selected options and
probabilities under a native decision interface. They can therefore be
relevant to SMS classification rather than merely embedding-based domain
routing. This does not verify the requested 3.0 release's membership,
architecture, input limit, license or interfaces. Native decision output is
not assumed to be a generated JSON chat answer or a reply draft.

The official example describes System One-shaped state/questions and a
separately deployed HTTP endpoint; downloading weights does not create an
endpoint. Its earlier compact encoder models list a 1,024-token total input
budget, whereas larger earlier variants list longer budgets. Verify the
**selected 3.0 card**, including the entire state/question/choice budget;
do not carry those earlier limits forward as 3.0 facts.

For Perplexity, Baseten's specific v1 deployment example uses an H100 and 80Gi
memory. This is an example, not a universal minimum or a cost measurement.
The current environment has no GPU, PyTorch or Transformers installed. Hosted
API testing is a plausible way to keep this development environment while
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

## Current blocker and next action

The current network policy produced proxy CONNECT 403 for Hugging Face; this
is not a 403 from the model collection itself and does not imply it is missing.
A domain-addition draft for Hugging Face/Microsoft/Perplexity research was
saved and reviewed, but subsequent runtime access still failed. The user was
asked to save/apply the additions in environment settings. Runtime network
access must be verified after that action.

The user also confirmed no existing inference access for the candidate models.
After the model cards and hosted metadata are accessible, choose the supported
test endpoints, declare only the credentials they actually require through
environment secret settings, and run bounded trials. The published OpenRouter
path may cover Microsoft and Perplexity with one account; its current API
availability still needs verification. Decision 3.0 may need its own deployment.
No paid inference calls, model downloads, new SMS or runtime changes occurred.

The offline scorer and exporters were exercised, including rejection of bad
hashes, missing/duplicate cases and invalid results. Baseline metrics were
independently recomputed from the saved predictions. Phase 0.4 remains open
until actual candidate results and a defensible measured decision are recorded.
