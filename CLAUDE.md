# Claude Code Project Instructions

The project-wide AI development rules are defined in:

```text
AGENTS.md
```

Read and follow `AGENTS.md` before modifying project files.

`AGENTS.md` is the source of truth for:

- project architecture
- database and replication safety
- coding conventions
- change approval policy
- dependency policy
- testing policy
- Git policy
- reporting requirements

Do not override `AGENTS.md` with assumptions or personal preferences.

When a better architecture or implementation is identified, propose it first and wait for explicit user approval before making the change.

For non-trivial changes:

1. Investigate the existing implementation.
2. Explain the current state and problem.
3. Propose the change.
4. Identify affected files.
5. Wait for approval when required by `AGENTS.md`.
6. Implement only the approved change.
