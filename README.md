# FlowForge for Google Flow

A Chrome extension (plus an optional local agent) that turns Google Flow into a production tool:
durable queues, spreadsheet imports, a reference/character library, storyboards with scene
continuity, a visual workflow canvas, verified downloads, and a local REST / OpenAI-style / MCP API.

FlowForge is an independent product, not affiliated with Google. It drives the Flow page in your own
signed-in tab, the way you would by hand, so generations use your own Flow credits and limits.

> **Working name.** "FlowForge" lives in `packages/core/src/product.ts` and the extension
> manifest. Check the name for trademark conflicts before launch.

## What's in the box

| Area | What it does |
|---|---|
| **Queue** | Paste or import prompts; per-row mode, ratio, outputs, model, duration, references, folder. Start / pause / resume / stop, drag to reorder, search, filters, bulk retry, CSV run report, ETA. |
| **Reliable engine** | Explicit job state machine (20 states), saved to IndexedDB before every step. Retries with exponential backoff and jitter only for transient errors. Rate limits wait 4× longer. Stops the queue after N failures in a row. Idempotency keys. Recovers after service-worker restarts and tab reloads, and never silently resubmits a job Flow may already be generating. |
| **Honest automation** | A captcha, unusual-activity notice, sign-in prompt or Flow agreement pauses the queue and waits for you. Nothing is bypassed, and agreements are never accepted for you. Prompts Flow refuses are skipped and shown with Flow's own wording. |
| **Imports** | TXT (line, blank-line or `---` / `@@@NEXT@@@` split), CSV/TSV, XLSX, JSON, pasted Sheets tables. Column mapping preview, duplicate detection, inline directives (`[aspect: 9:16] [n: 2] [mode: t2v]`), `{a\|b}` prompt variations, `{{column}}` variables. |
| **Library** | Every output with a thumbnail, size, duration, SHA-256 and its path on disk. Re-download, use as reference. Reference images with aliases, tags and collections. Character sheets (look, wardrobe, always/never) that are restated in every scene. `@mira` in a prompt attaches that image. |
| **Storyboard** | Paste a script and it splits into scenes (dialogue detected). Shot, camera, location, cast. Continuity is "fresh", "same references" or "from last frame": the next scene starts from the previous clip's final frame. |
| **Workflow canvas** | Nodes for prompt, asset, image, video, last frame, pick output, merge, note. Typed ports, validation with click-to-locate issues, run all, run from a node (reuses earlier outputs), live status and thumbnails on nodes, templates, JSON import/export (AI-editable comments). |
| **Output checks** | A job only succeeds when the output matches the request: media type, non-empty file, magic bytes, aspect ratio, count. Wrong type fails; a different ratio or count is flagged. |
| **Downloads** | Auto-download with templates (`{queue}/{index:03}_{slug}{variant}`, `{var.column}`, sub-folders), safe Windows/macOS names, collision handling, retry download. |
| **Flow controls** | Ratio, count and model are set in Flow's own Agent settings panel (verified on the live UI). If a control is missing, the request text says it instead, or the job fails as unsupported (your choice). Flow's "Upload media" picker is used for references. "What's new" dialogs are closed. |
| **Self-healing selectors** | Everything FlowForge knows about Flow's page is a data "selector pack" that can be updated without a release. You can also "Teach" a control by clicking it. "Check page" and "Map Flow's UI" are built in for diagnosis. |
| **Local agent (Pro)** | `flowforge-agent serve`: REST API, OpenAI-compatible `/v1/images/generations`, an MCP server (14 tools) for Claude, Cursor and other clients, a CLI, and FFmpeg merge, last-frame, probe and slideshow. Bound to 127.0.0.1 and token-paired. It never sees your Google session. |
| **Plans** | Free and Pro/Lifetime gates, offline-verified Ed25519 license keys, and a daily job quota shown separately from Google's credits. |

## Install (development)

```bash
npm install
```

```bash
npm run build
```

Then in Chrome open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick
`packages/extension/dist`. Open https://flow.google.com, open a project, and click the FlowForge
toolbar icon to open the side panel.

## Test without spending credits

```bash
npm run e2e
```

This builds the dev extension, starts a mock Flow page on `localhost:5179`, and runs the real
extension in Chromium through 23 checks: queue runs, retries, policy skip, captcha pause, agreement
pause, the Agent-settings panel, picker uploads, the agent's confirmation button, last-frame
chaining, downloads, license activation, agent pairing, REST, the OpenAI-style API, FFmpeg merging
and the workflow canvas. There are also unit tests:

```bash
npm test
```

## Layout

```
packages/core       shared model: job state machine, retry policy, importers, templates,
                    workflow compiler, storyboard compiler, output checks, licensing, bridge protocol
packages/extension  MV3 extension: background engine, Flow content-script adapter, side panel (React)
  mock/             mock Flow pages used by the e2e test
packages/agent      local agent: REST + OpenAI-style API, MCP server, CLI, FFmpeg
tools/license.mjs   create the signing key and issue license keys
docs/               agent reference, launch notes, verification status
```

## Selling it

See [docs/LAUNCH.md](docs/LAUNCH.md): suggested pricing, how license keys work with a payment
provider, the store listing and privacy disclosure, and what still has to happen before you charge.

**Back up `tools/license/private.key`.** It signs every license key. It is git-ignored; if you lose it,
keys you already sold cannot be reissued; if it leaks, anyone can mint Pro keys.
