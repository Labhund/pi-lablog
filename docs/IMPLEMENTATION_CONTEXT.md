# Implementation context

This document records the Pi-side context receiver and its relationship to
observational memory and the shared science workbench. The origin session is
a supplementary pointer; the implementation and durable records remain the
source of truth.

## Current scope

- `src/context.ts` registers a short-lived receiver for a Pi session inside a
  detected lab project.
- Browser notebook envelopes are routed through atomic per-project and
  per-session inbox files.
- The receiver claims each file once and injects the formatted notebook
  context as a real user message, using follow-up delivery when Pi is busy.
- Notebook context is deliberately not silently promoted into observational
  memory or the scientific lab record. It is an explicit user request that
  tells Pi what to inspect.
- The broader lablog extension continues to project observational-memory
  observations into the provisional weekly capture stream; durable notebook
  entries remain scientist-reviewed records.

## Origin session (supplementary local provenance)

The receiver and browser handoff were implemented and runtime-validated in Pi
session `01a03b2f-2e8c-7845-8977-406118b109f1` on 2026-08-26, from the
`tRNA_paper` project. The session covered receiver registration, real user
message delivery, the code-cell handoff fix, and integration with the shared
Jupyter workbench.

On the original machine, inspect it with:

```bash
python3 ~/.pi/agent/skills/analyze-sessions/scripts/show_session.py \
  --session 01a03b2f \
  --include-subagents-content
```

The raw transcript is local Pi state and is intentionally not copied into the
repository. It may contain private paths or tool output. Treat it as
supplementary implementation history; current source, tests, and project
records take precedence.

## Related components

- Shared workbench: <https://github.com/Labhund/science-workbench>
- Browser context bridge: local repository
  `/home/labhund/repos/pi-jupyter-context`
- Personal Pi configuration and stubs: <https://github.com/Labhund/pi-config>
