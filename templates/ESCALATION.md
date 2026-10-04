# Escalation

<!--
Guidance for the escalation agent, which gets a request (a blocker, a decision, a stall, a split
to review, a spent budget) before a person does, when `escalation.enabled` is on. Ralph adds
whatever is outside this comment to the agent's prompt, where it overrides the defaults.

Say what it may settle on its own and what must always come to you, for example:

- Prefer the standard library over adding a dependency.
- Any choice that costs money or touches production data comes to me.
- A failing integration test against the staging API is not a blocker: skip it and resume.
-->
