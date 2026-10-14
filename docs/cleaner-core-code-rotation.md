# Outdoor code: rotate and offboard

Cleaner Core does not change the lock. The host does that on the lock, then tells Cleaner Core the new code in a private text. The store keeps a sealed reference. The code is sent only to that property's opted-in approved cleaner, and only after the host says the guests have left.

The host-facing text, also returned by `npm run cleaner:health`, is:

> To change the outdoor code at {address}, set the new code on the lock yourself, then tell me the new code in a private text. I store only a sealed reference. I do not change the lock. To offboard a cleaner, reply STOP from their number or tell me to remove them. I will not send the code again until you confirm a new cleaner and the guests have left.

Steps for the host:

1. Set the new code on the lock.
2. Text the new code in a private message to the scheduler. Do not put it in a group.
3. To offboard a cleaner, have that cleaner reply STOP, or tell the scheduler to remove them.
4. Confirm the next cleaner. The code is not sent again until that cleaner has opted in and the guests have left.

A text that contains the code, or the words "door code" followed by digits, opens one "possible code exposure" review for the host and does not repeat the digits.
