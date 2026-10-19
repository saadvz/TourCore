# Group thread for the host and the cleaner

Cory is in the cleaning thread from the texting setup step and does not text YES. Maria opts in by text, then they read the same thread. The door code never goes to that thread. Maria gets it privately. After delivery, Cory reads "Maria got the door code privately." from get_state. Cory's texts do not move the job. A hurt message gets the same 911 reply as a one-on-one text, and the thread does not see it.

## Sub-features

- `eligible` sends one private door code after Maria replies YES and confirms. Cory is already in the thread from the texting setup step. The thread does not contain the code.
- `private` sends the code one-on-one when Alex has joined. The group does not get the private line.
- `held` sends no code after the cleaner replies STOP, and the job does not clear.
- `stop-host` drops Cory from later group texts and leaves Maria on them.
- `resume` sends one resume line to Cory. Maria's START does not clear the hold.
- `time` leaves 11:00 AM in place. Cleaner Core sends no time line; Grok reads the message and tells Cory.
- `injury` sends the one-on-one 911 lines and the injury hold to Cory, and no group text.
- `problem` holds nothing and opens no review. Grok reads the message, tells Cory, and asks whether to pause; only Cory's yes pauses it, with `hold_job`.
- `before-yes` sends Maria's invite one-on-one and no group text. Cory is not asked to reply YES.
- `inert` keeps the old private door code when group chat is off.
- `done` reaches done from Maria's START and DONE. Cory gets one ready line.
- `done-without-start` reaches done from Maria's DONE after the private code. A second DONE does not send a second ready line.
- `twice` sends the private code once.
- `failed` retries a failed private code once and does not put it in the thread.
- `desk` keeps the missing-key note, the sent note, and the already-sent note. The thread does not receive the code.

## How to get to it (user POV)

- The host turns group chat on for Scratch Lane.
- Maria gets one text naming the group and replies YES. Cory is already in the thread from the texting setup step.
- The host confirms 11:00 AM and 4:00 PM through confirm times. Maria replies YES to schedule.
- The host says the guests have left. The code goes to Maria alone. The thread does not receive it.
- A time, a STOP, a hurt message, or a problem in the thread follows the rules above. Only the host pauses a cleaning, and only the host's resume puts the job back on.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Phones are `+15555550100`, `+15555550101`, and for the private journey `+15555550122`.

- **Run the proof.** `.cursor/skills/verify-cleanercore/scripts/prove-group-chat.sh` takes no arguments. Exit code 0. It prints `evidence/group-chat`.
- **Result.** Each journey directory has a passing `result.txt`. The desk file has the missing-key note, `I sent the door code to the cleaner. I'll tell you if it doesn't go through.`, and `I already sent the door code to the cleaner.`
- **Proof.** The evidence tree has no scratch door-code digits and no phone outside area code 555.

## Gotchas

- `--group-chat` is required. Without it the private door-code sentence stays, and that is the `inert` journey.
- A second `guests have left` in smoke sends no second code. The already-sent sentence is the desk reply, saved in `desk/desk.json`.
- HELP is not a step in this proof. A HELP text is not answered here.
