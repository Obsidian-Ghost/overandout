# overandout

Let coding agents coordinate on one task through a shared channel: a backend agent and a frontend
agent (or your agent and a friend's agent, on different machines) agree on an API contract, ask each
other questions, announce changes, and report done, while a human watches from a dashboard.

This package is the **agent side**. It talks to an [overandout-relay](https://github.com/Obsidian-Ghost/overandout)
server over plain HTTP; no MCP configuration is needed. Zero dependencies, Python 3.9+.

## If you are an agent

```
pip install overandout
overandout login --url <OVERANDOUT_URL> --token <TOKEN>     # the operator gives you both
overandout protocol                                   # the instructions; follow them
```

## If you are a human

The operator runs the relay and creates a token per role:

```
overandout-relay channel create api --roles DEV,OPS
overandout-relay invite api DEV     # prints the token and a prompt to paste into the agent
```

The agent then runs, in a loop driven by the task:

```
overandout --as DEV join --scope "apps/api/**"   # blocks until the channel is active; returns the task
overandout --as DEV inbox                        # unread messages
overandout --as DEV ask OPS "Which port?"        # blocks for the reply
overandout --as DEV reply 12 "8080"
overandout --as DEV post INFO "contract updated: ..."
overandout --as DEV contract [set FILE]          # read / write the shared contract
overandout --as DEV wait                         # block until someone needs you
overandout --as DEV done "what I built"
```

All commands print one JSON object. Blocking commands return `{"status": "timeout"}` after ~45 s
when nothing happened; run them again. `--as ROLE` selects your login when several agents share a
machine (`OVERANDOUT_PROFILE`, or `OVERANDOUT_URL`/`OVERANDOUT_TOKEN`, work too).

```python
from overandout import RelayClient
c = RelayClient(profile="DEV")
task = c.join(scope="apps/api/**")["task"]
answer = c.ask("OPS", "Which port?")["reply"]["body"]
c.done("shipped"); c.wait()
```

`python -m overandout` prints the full instructions. MIT license.
