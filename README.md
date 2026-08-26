# pi-lablog

> **Work in progress.** File formats and commands may still change.

Background scientific capture for [pi](https://github.com/earendil-works/pi) lab work.
When a session is running inside a lab project, pi-lablog re-projects new session
activity into a lab-level **weekly capture stream**.

**It is designed to run on top of [pi-observational-memory](https://github.com/amosblomqvist/pi-observational-memory).**
The two are complementary layers over the same session:

- **pi-observational-memory** is session-scoped: parallel observers distill the
  conversation into atomic observations, and a consolidator compacts them into the
  session's `.memory/` files. Its unit of permanence is the *session*.
- **pi-lablog** is lab-scoped: it consumes those same observations as they appear
  and re-projects them into the lab's weekly capture stream — the raw material for
  the lab's notebooks. Its unit of permanence is the *project/week*.

So an observation recorded once in a session feeds both the session's own memory
and the lab record, with provenance ids linking the two. pi-lablog still works
without pi-observational-memory (it falls back to raw session entries), but it is
meant to be used with it.

It is deliberately quiet: capture runs in the background after `agent_start` /
`turn_end`, is watermark-based (each observation is captured at most once), skips
the model call when there isn't enough new activity, and never blocks or breaks
the session.

For the Jupynium science workbench it also registers a short-lived receiver in
`/tmp/pi-jupyter-context/`. The classic Notebook context extension can route an
explicit cell/selection request to the newest Pi session for the project. Pi
receives that envelope as a real user message; it is not silently promoted to
scientific memory.

## How projects are detected

1. **Explicit marker** — a `.lablog.toml` in the project directory or any ancestor of the cwd:

   ```toml
   project = "tRNA-broadcast-paper"
   lablog = "/data2/loo_lab/_lablog"
   # model_provider = "openrouter"   # optional: capture agent provider override
   # model_id = "moonshotai/kimi-k3"  # optional: capture agent model override
   # passive = true                  # optional: disable background capture
   # notify = true                   # optional: short notice per capture run
   ```

2. **Implicit git rule** — the cwd is inside a git repo under the lab root, so it
   counts as a lab project (project = repo directory name).

3. **Manual declaration** — `/lablog:on <project> [lablog-path]` for sessions where
   neither of the above applies.

The lab root and default lablog path are compiled-in defaults pointing at the
author's lab (`/data2/loo_lab`, `/data2/loo_lab/_lablog`) — set your own via the
marker, or edit `LAB_ROOTS` / `DEFAULT_LABLOG` in `src/config.ts`.

## Commands

| Command | What it does |
| --- | --- |
| `/lablog:status` | capture state for this session: marker, watermark, record count, last error |
| `/lablog:view [week]` | the capture stream for a week (default: current), filtered to this project when capture is on |
| `/lablog:on <project> [lablog-path]` | declare this session as working on a lab project |
| `/lablog:off` | disable capture for this session |

## Capture stream

Records are appended as JSONL under `<lablog>/capture/<week>.jsonl`. Each record:

```jsonc
{
  "v": 1,
  "id": "…",            // dedup id: hash(session, kind, mode, text, om ids)
  "ts": "…", "week": "2026-W34",
  "project": "…", "session": "…",
  "kind": "assertion",  // assertion | action | result | artifact | note
  "mode": "canonical",  // exploratory | canonical
  "text": "…",
  "om": ["…"],          // supporting observational-memory observation ids
  "source": ["…"],      // raw session entry ids (when no om id covers the fact)
  "files": ["…"]
}
```

Provenance labels mirror pi-observational-memory's source-addressed format, so a
record can be traced back to the exact session entries it was distilled from.

## Install

```bash
pi packages install git:github.com/Labhund/pi-lablog
```

Requires a pi with TS extension loading. Install alongside
[pi-observational-memory](https://github.com/amosblomqvist/pi-observational-memory) —
pi-lablog is designed to run on top of it (see above).

## Development

The extension is plain TypeScript loaded directly by pi — no build step and no
`npm install`. Its only external imports (`@earendil-works/pi-ai`,
`@earendil-works/pi-coding-agent`, `typebox`) are provided by the pi runtime.
