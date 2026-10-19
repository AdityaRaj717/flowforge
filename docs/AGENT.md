# FlowForge local agent

Optional companion (Pro plan) that gives other programs a way to use FlowForge. It runs on your
computer, listens on `127.0.0.1` only, and talks to the extension over a token-paired WebSocket.
It never receives Google cookies or tokens: it asks the extension to queue work, and the extension
runs it in your Flow tab.

## Start and pair

```bash
node packages/agent/dist/cli.mjs serve
```

It prints a pairing token. In FlowForge open **Settings › Local agent**, paste the token and tick
**Connect to the local agent**. `flowforge-agent token --rotate` issues a new one.

Config lives in `~/.flowforge/agent.json` (port, token, ffmpeg path). Environment overrides:
`FLOWFORGE_PORT`, `FLOWFORGE_HOME`, `FFMPEG_PATH`, `FFPROBE_PATH`.

## REST

Every route except `/health` needs `Authorization: Bearer <token>`. Requests that carry a web page's
`Origin` header are refused, so websites you visit cannot drive your queue.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/health` | | agent + connection status |
| GET | `/v1/status` | | plan, Flow tabs, queues |
| GET | `/v1/queues` | | queues with status |
| GET | `/v1/jobs` | `?queue=&state=failed,policy_blocked&limit=` | job summaries |
| POST | `/v1/jobs` | `{prompt}` or `{prompts:[]}` or `{items:[{prompt,mode,options}]}`, plus `mode`, `aspect`, `outputs`, `model`, `duration`, `queue`, `start` | `{queueId, jobIds}` |
| GET | `/v1/jobs/:id` | | job with outputs and local media URLs |
| GET | `/v1/jobs/:id/wait` | `?timeout=600` (s) | the job once finished or needing you |
| POST | `/v1/jobs/:id/cancel` · `/retry` | | |
| POST | `/v1/queues/:id/start` · `pause` · `resume` · `stop` | | |
| GET | `/v1/workflows` · POST `/v1/workflows/:id/run` | `{fromNodeId?}` | |
| POST | `/v1/post/merge` | `{files:[], output?, loudnorm?}` | merged MP4 info |
| POST | `/v1/post/lastframe` | `{file, output?}` | PNG path |
| POST | `/v1/post/probe` | `{file}` | duration, size, codec, audio |
| POST | `/v1/post/slideshow` | `{images:[], secondsPerImage?, size?}` | MP4 path |
| POST | `/v1/images/generations` | OpenAI images body (`prompt`, `n`, `size`, `response_format`) | OpenAI-shaped response; blocks until done |

Modes: `text-to-image`, `image-to-image`, `text-to-video`, `frames-to-video`, `ingredients-to-video`, `extend-video`.

## OpenAI SDK

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:47321/v1", api_key="<pairing token>")
img = client.images.generate(prompt="a lighthouse at dusk", n=2, size="1024x1792", response_format="b64_json")
```

## MCP (Claude Desktop, Claude Code, Cursor, …)

Add a stdio server that runs:

```json
{ "command": "node", "args": ["D:/path/to/packages/agent/dist/cli.mjs", "mcp"] }
```

The agent (`serve`) must be running. Tools: `flowforge_status`, `flowforge_generate`,
`flowforge_get_job`, `flowforge_wait`, `flowforge_list_jobs`, `flowforge_list_queues`,
`flowforge_queue_control`, `flowforge_retry_job`, `flowforge_cancel_job`, `flowforge_list_workflows`,
`flowforge_run_workflow`, `flowforge_merge_videos`, `flowforge_last_frame`, `flowforge_probe`.

## CLI

```
flowforge-agent serve | token [--rotate] | mcp | status | doctor
flowforge-agent gen "prompt" ["prompt" ...] [--mode t2v] [--aspect 9:16] [-n 2] [--model "Veo 3.1 - Fast"] [--queue NAME] [--wait]
flowforge-agent gen --file prompts.txt --wait
flowforge-agent jobs [--state failed] [--limit 20]
flowforge-agent wait JOB_ID
flowforge-agent merge out.mp4 a.mp4 b.mp4
flowforge-agent lastframe clip.mp4 [out.png]
```
