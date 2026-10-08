Tiny ping feature, contract first.

BE (owns demo/api/**):
1. Write the contract with `overandout --as BE contract set <file>`: GET /ping -> 200 { "pong": true, "at": "<ISO time>" }.
2. Post INFO "contract ready".
3. Answer FE's questions with reply.

FE (owns demo/web/**):
1. Wait for "contract ready", read the contract.
2. Ask BE one question before implementing.

Both: done with a summary, then wait until closed.
