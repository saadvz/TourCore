# Flag off sends nothing

With `CLEANER_CORE_ENABLED` unset, the landlord's cleaning job sends no texts. Touring texts are unchanged. Doctor reports the flag off and still sends nothing.

## Sub-features

- `flag-doctor-off` reports `enabled` false and `sends` false.
- `flag-smoke-off` refuses the Scratch turnover, exits 2, and records no texts and no pin recipient.
- `flag-on-is-different` does not treat a flag-on doctor (`sends` false while `enabled` is true) as this journey.

## How to get to it (user POV)

- The landlord leaves `CLEANER_CORE_ENABLED` unset (off unless the value is `1` or `true`).
- Nobody at Scratch Lane receives a host question, a turnover offer, or a confirmation from Cleaner Core.
- The harness entries are doctor and smoke with the variable removed from that process only.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- The command's own environment has `CLEANER_CORE_ENABLED` unset. Use `env -u CLEANER_CORE_ENABLED` even when the parent shell looks empty.
- `TOURCORE_PUBLIC_BRAND_NAME` is irrelevant here. Flag off sends no brand line because it sends nothing.
- Doctor for this drive is the flag-off doctor, not the flag-on document.

- **Doctor off.** Run `env -u CLEANER_CORE_ENABLED npm run --silent cleaner:doctor`. Exit code 0. Stdout matches `scripts/expected/doctor-off.json`:

```json
{
  "ok": true,
  "enabled": false,
  "sends": false,
  "note": "Cleaner Core is off. Touring texts are unchanged."
}
```

- **Smoke off.** Inject a Scratch YES while the flag is unset. Run `env -u CLEANER_CORE_ENABLED npm run --silent cleaner:smoke -- --reply +15555550100=YES`. Exit code 2. Stdout matches `scripts/expected/smoke-off.json`:

```json
{
  "ok": false,
  "reason": "disabled",
  "sent": [],
  "pinRecipients": []
}
```

`sent` has no offer, no confirm, and no pin. `pinRecipients` is empty.
- **Proof.** Save both commands, both stdouts, both stderrs, and both exit codes with feature id `flag-off`. Re-read the saved smoke stdout and require `sent` and `pinRecipients` to be empty arrays. There is no second store.

## Gotchas

- `CLEANER_CORE_ENABLED=1` in the parent shell is inherited by `npm run`. `env -u` is the unset. A bare `npm run cleaner:smoke` from a shell that exported the flag is the flag-on journey.
- `true`, `TRUE`, and `1` turn the flag on. `yes`, `0`, and an empty value leave it off. This recipe drives unset, not those other off values.
- Doctor always prints `sends: false`, including when the flag is on. The flag-off proof is `enabled: false` plus the smoke document with exit 2 and empty `sent`.
- Smoke with no `--reply` also exits 2 when the flag is unset. This recipe includes `--reply +15555550100=YES` so the proof shows that reply still sends nothing.
- Do not run flag-on smoke in this recipe. With no operation that sends the host questions, the offer, and the confirm inside the process. It does not text a door code.
