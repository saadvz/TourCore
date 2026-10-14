# STOP before departure holds the door code

If the cleaner replies STOP before the host confirms departure, the private text is not sent. The host is told the cleaner opted out. A later START opts the cleaner back in and does not send the code.

## Sub-features

- `stop-ack` replies to the cleaner with the Tour Core STOP sentence.
- `held-notice` tells the host `The cleaner opted out, so the door code wasn't sent. Please reach them directly.`
- `start-without-pin` answers START with the opt-back-in sentence and leaves `pinRecipients` empty.

## How to get to it (user POV)

- The cleaner opts in, the host confirms the turnover, and the cleaner replies STOP.
- The host says the guests have left. The cleaner does not receive a door code. The host receives the held sentence.
- The cleaner replies START and is opted back in. The door code is not sent.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- The drive passes `--with-pin` and the Guesty fixture.

- **Stop, depart, start.** Run `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --with-pin --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --reply +15555550101=YES --reply +15555550100=YES --reply +15555550100=YES --reply +15555550101=YES --reply +15555550101=STOP --reply "+15555550100=guests have left" --reply +15555550101=START`. Exit code 0.
- **Texts.** The cleaner receives `Tour Core: You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.` The host receives the held sentence once. START replies `You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.` No `kind` is `pin`. `pinRecipients` is `[]`.
- **Proof.** Save the command, stdout, stderr, exit code, and transcript with feature id `stop-holds`.

## Gotchas

- The STOP sentence starts with `Tour Core:`. That prefix belongs to the touring opt-out copy. Do not change it to prove this journey.
- START after a delivered door code is the full-turn reply `Got it, cleaning started.` This START happens before any private text.
