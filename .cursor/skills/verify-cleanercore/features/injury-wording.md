# Injury wordings

A text that says hurt, injured, injury, bleeding, blood, fell, fall, or fallen is an injury, in any casing, anywhere in the text. The cleaner and an observer each get the 911 reply, and the host is alerted. The reply is not a group text. The same words a second time send nothing.

## Sub-features

- `hurt` answers `she's hurt` and `someone got hurt`.
- `fell` answers `Cleaner fell down the stairs, she's hurt`, `she fell and can't get up`, and `I fell and I'm hurt`.
- `injured` answers `I'm injured`.
- `blood` answers `there's blood everywhere`.
- `both-modes` does each of those from `+15555550101` and from `+15555550122`, in a group and one-to-one.
- `everyday` records `that hurt my schedule lol, running late` from the cleaner in one-to-one mode and does not require a particular outcome.

## How to get to it (user POV)

- The cleaner or the observer texts one of the phrases above.
- In a group, both have already replied YES.
- One-to-one does not require that YES first.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- One-to-one passes `--group-mode cleaner-only` and `--participant observer=+15555550122`.
- A group passes `--with-pin`, `--group-mode native`, `--group-capable`, and `--participant observer=+15555550122`, then YES from `+15555550101` and `+15555550122`.

- **Each wording.** For each phrase, run one-to-one and a group. The cleaner sends the phrase, then the observer sends the same phrase. Exit code 0.
- **Result.** After the checkout question (and, in a group, the two opt-in texts), `sent` has four emergency texts: `The cleaner at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.` to `+15555550100`, `If someone is hurt, call 911 now. I've let the host know.` to `+15555550101`, `An observer at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.` to `+15555550100`, and `If someone is hurt, call 911 now. I've let the host know.` to `+15555550122`. No emergency text has a channel.
- **Everyday.** Run one-to-one with `--reply "+15555550101=that hurt my schedule lol, running late"`. Save the stdout. Do not require it to be an injury or not.
- **Proof.** Save the command, stdout, stderr, exit code, transcript, and job list with feature id `injury-wording`. `prove-step-f.sh`.

## Gotchas

- Quote each reply. The spaces belong to one `--reply` value.
- A second injury from the same sender on the same job sends nothing, so each phrase needs its own smoke process.
- The everyday stdout is saved and is not part of the assertion.
