# Group thread for the host and the cleaner

Cory and Maria opt in one-on-one, then read the same cleaning thread. The door code goes to that thread only when both have opted in and nobody else is in it. Otherwise Maria gets it privately and the thread does not hear that. Cory reads that line from get_state after the text is delivered. Cory's texts do not move the job. A hurt message gets the same 911 reply as a one-on-one text, and the thread does not see it.

## Sub-features

- `eligible` sends one group door code after both people reply YES and the cleaner confirms.
- `private` sends the code one-on-one when Alex has joined. The group does not get the private line.
- `held` sends no code after the cleaner replies STOP, and the job does not clear.
- `stop-host` drops Cory from later group texts and leaves Maria on them.
- `resume` sends one resume line to Cory. Maria's START does not clear the hold.
- `time` leaves 11:00 AM in place and tells the thread Cory will confirm it.
- `injury` sends the one-on-one 911 lines and no group text.
- `problem` sends the hold line to Cory and Maria and nothing to the thread.
- `before-yes` sends the invites one-on-one and no group text.
- `inert` keeps the old private door code when group chat is off.
- `done` reaches done from Maria's START and DONE.
- `twice` sends the group code once.
- `failed` cancels a failed group code and does not send it again.
- `desk` keeps the missing-key note, the one failure note, and the already-sent note.

## How to get to it (user POV)

- The host turns group chat on for Scratch Lane.
- Maria and Cory each get one text naming the group and the other person. Each replies YES.
- The host confirms 11:00 AM and 4:00 PM through confirm times. Maria replies YES to schedule.
- The host says the guests have left. The code goes to the thread, or to Maria alone when someone else has joined.
- A time, a STOP, a hurt message, or a problem in the thread follows the rules above. Only the host's resume puts the job back on.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false and `enabled` true.
- Phones are `+15555550100`, `+15555550101`, and for the private journey `+15555550122`.

- **Run the proof.** `.cursor/skills/verify-cleanercore/scripts/prove-group-chat.sh` takes no arguments. Exit code 0. It prints `evidence/group-chat`.
- **Result.** Each journey directory has a passing `result.txt`. The desk file has the missing-key note, the failed-send note, and `I already sent the door code to the cleaner.`
- **Proof.** The evidence tree has no scratch door-code digits and no phone outside area code 555.

## Gotchas

- `--group-chat` is required. Without it the private door-code sentence stays, and that is the `inert` journey.
- A second `guests have left` in smoke sends no second code. The already-sent sentence is the desk reply, saved in `desk/desk.json`.
- HELP is not a step in this proof. A HELP text is not answered here.
