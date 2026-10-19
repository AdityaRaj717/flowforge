# Launch notes

## Where it stands against the audit

| Audit "must have" / differentiator | FlowForge |
|---|---|
| Table queue, per-row overrides | Yes |
| TXT / CSV / XLSX / JSON import, mapping, duplicates | Yes (DOCX not yet; Sheets via paste) |
| Persistent queue, pause / resume / stop / skip | Yes; survives service-worker restarts and tab reloads |
| Explicit state machine, idempotency, stale-job recovery | Yes (`packages/core/src/state.ts`, engine leases) |
| Retry only recoverable failures, backoff, circuit breaker | Yes (`packages/core/src/retry.ts`) |
| Pause on captcha / unusual activity / sign-in / agreements, never bypass | Yes, covered by e2e |
| Output verification (type, size, ratio, count, hash) | Yes |
| Asset library, characters, @mentions, filename matching | Yes |
| Storyboard + last-frame continuity | Yes |
| Visual workflow: validation, run all / run from node, templates, JSON | Yes |
| Rename templates, sub-folders, re-download | Yes |
| Logs, sanitized diagnostics export | Yes (prompts, tokens and emails stripped) |
| Plan / quota UX separate from Google credits | Yes |
| Selector pack updates + click-to-teach | Yes |
| Local REST, OpenAI-compatible, MCP, CLI | Yes (agent) |
| FFmpeg merge / last frame / slideshow | Yes (agent) |
| Video prompt extractor, clip maker, AI graph builder | Not yet (roadmap) |
| Website / billing / accounts | Webhook + revocation list built (`packages/license-server`), not deployed; no website yet |

What none of the reviewed competitors combine: a verified-output state machine, explicit
"needs you" handling instead of evasion, self-healing selectors, and queue + workflow + storyboard +
local API in one product.

## Verification status (be precise in marketing)

Verified against the live flow.google.com UI (19 Oct 2026, read-only, no generations):
prompt box, Start generation, Start new session, the composer Settings → Agent settings panel
(image ratios 16:9/4:3/1:1/3:4/9:16, video ratios 16:9/9:16, x1–x4, models Nano Banana Pro /
2 Lite / 2.1 and Omni 1.1 Flash / Veo 3.1 Lite / Fast / Quality), Add ingredients → Upload media
file input, the "Rights to use this image" agreement, the changelog dialog.

Verified end to end on mock pages that copy that structure (23 e2e checks).

**Not yet verified live** (needs one real generation, which uses credits): how Flow shows
progress and finished media in chat, the exact wording of its confirmation button and error
messages, and how uploaded references appear as chips in the prompt box. The adapter has
fallbacks for each and reports what it saw. Run the live checklist below before charging.

## Live checklist (first real run)

1. Load the release build, open a Flow project, Settings › Flow controls › **Check page**: all
   non-optional controls should say "found".
2. Queue 1 image prompt with `[n: 1]`. Watch it go Preparing → Submitting → Generating → Verifying →
   Downloading → Done, and check the file in Downloads/FlowForge.
3. Queue 1 video prompt. Same.
4. A prompt with `@alias` for a Library image (accept Flow's upload agreement once when asked).
5. A 2-scene storyboard with "From last frame".
6. Leave the Flow tab in the background for a 10-job run and note any slowdowns.
7. If anything fails, **Map Flow's UI** and **Export diagnostics** show exactly what the page had.

## Suggested pricing (not decided yet)

Competitors: $3/mo (VEO Automation Max), $4/mo or $20/yr (Auto Flow Pro), $4.99/mo or $49.99
lifetime (AutoPlayLabs), $9.99/mo (AutoFlow Studio), $12 lifetime (KoseFlow).

FlowForge is local-first (almost no server cost) and does more than all of them, so:

- **Free:** 30 jobs/day, 1 Flow tab, workflows up to 12 nodes, storyboards up to 6 scenes.
- **Pro:** $6.99/month or $49/year. Unlimited FlowForge jobs, 3 parallel tabs, unlimited
  workflows and storyboards, local API / MCP / CLI, FFmpeg tools.
- **Lifetime:** $79 one-time, with updates for the 1.x line spelled out on the pricing page.

Plan limits live in `packages/core/src/license.ts` (`PLANS`).

## Selling license keys

`node tools/license.mjs keygen` was already run; the public key is embedded in
`packages/core/src/license.ts`. **Back up `tools/license/private.key` offline.** Buyers paste their
key in Settings › Plan, and keys verify offline. `tools/license.mjs sign` still works for manual keys
(support, giveaways).

### License server (`packages/license-server`)

A Cloudflare Worker that turns Lemon Squeezy payments into license keys:

| Event | What happens |
|---|---|
| `order_created` (status `paid`) | Signs a key (`lid` = `ord_<order id>`) and emails it. Covers lifetime and the first subscription payment. |
| `subscription_created` / `_updated` | Remembers which variant the subscription is on (invoices don't carry it). |
| `subscription_payment_success` (renewal) | Signs a fresh key (`lid` = `inv_<invoice id>`) and emails it. |
| `order_refunded` / `subscription_payment_refunded` | Adds that `lid` to the revocation list. |

- `GET /revoked` returns `{ revoked: [lid…] }`; `GET /revoked/<lid>` checks one;
  `POST /admin/revoke` (Bearer `ADMIN_TOKEN`) revokes by hand, e.g. for chargebacks.
- Prices are not in the code. `VARIANT_PLANS` maps Lemon Squeezy variant ids to plans, e.g.
  `{"111":{"plan":"pro","days":31},"222":{"plan":"pro","days":365},"333":{"plan":"lifetime"}}`.
  Subscription keys get `GRACE_DAYS` (default 3) extra so a late renewal never locks anyone out.
- Webhook retries are safe: each `lid` is signed once, and only a failed email is retried.
- The private key comes only from the `LICENSE_PRIVATE_KEY` secret. Tests use a throwaway key pair
  and check the result with `verifyLicense` (`npm test -w @flowforge/license-server`).

**Why Lemon Squeezy over Paddle:** both are merchants of record (they handle VAT/GST and invoices).
Lemon Squeezy approves individual sellers faster, has no minimum before payout, and its webhook
signature is a plain HMAC-SHA256 of the body. Paddle reviews the business and website before
approval, which is slower for a solo launch. The worker only touches the webhook, so switching later
means rewriting `webhook()` in `src/index.ts` and nothing else.

**Not wired yet:** the extension does not check `/revoked`. Revoked keys keep working offline until
it does (a daily fetch of `/revoked` in the background engine would do).

### Deploy steps (nothing is deployed yet)

1. Accounts: Cloudflare (Workers free plan is enough), Lemon Squeezy, and Resend for email
   (verify a sending domain there).
2. In Lemon Squeezy, create the product and variants once pricing is decided, and note each
   variant id.
3. From `packages/license-server`, sign in and create the KV store, then paste its id into
   `wrangler.toml`:

   ```bash
   npx wrangler@3.114.0 login
   ```

   ```bash
   npx wrangler@3.114.0 kv namespace create LICENSES
   ```

4. Set the secrets (each command prompts for the value; the private key is read from the file):

   ```bash
   npx wrangler@3.114.0 secret put LICENSE_PRIVATE_KEY < ..\..\tools\license\private.key
   ```

   ```bash
   npx wrangler@3.114.0 secret put VARIANT_PLANS
   ```

   Then the same for `LS_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM` (e.g.
   `FlowForge <keys@yourdomain>`) and `ADMIN_TOKEN` (a long random string).

5. Deploy:

   ```bash
   npx wrangler@3.114.0 deploy
   ```

6. In Lemon Squeezy › Settings › Webhooks, add `https://<worker url>/webhooks/lemonsqueezy` with the
   same signing secret, and tick `order_created`, `order_refunded`, `subscription_created`,
   `subscription_updated`, `subscription_payment_success`, `subscription_payment_refunded`.
7. Test with a test-mode order: set `ALLOW_TEST_MODE` to `true`, buy with a test card, paste the
   emailed key into the extension, then delete `ALLOW_TEST_MODE` before going live.

## Chrome Web Store

- Single purpose: "Queue, organize and download Google Flow generations."
- Permissions rationale: `sidePanel` (UI), `storage`/`unlimitedStorage` (local queue and library),
  `downloads` (save outputs), `tabs`/`scripting` (find and attach to Flow tabs), `alarms` (keep the
  queue on schedule), `notifications` (queue finished / needs you). Hosts: Flow and its media CDNs only.
- Privacy: prompts, media and settings stay in the browser. No analytics. The only network calls
  are to Flow (in your tab), Flow's media hosts (downloads), an optional selector-pack URL, and the
  optional local agent on 127.0.0.1.
- Say plainly: independent tool, not affiliated with Google; uses your own Flow credits and limits;
  does not bypass captchas, quotas or other protections.

## Not built yet (good next steps)

- Marketing site, pricing, privacy policy and terms (waiting on pricing and the design brief).
- Extension check against the license server's `/revoked` list.
- Live-run hardening from the checklist above (selector pack update).
- DOCX import, Google Sheets link import.
- Video prompt extractor and clip maker (agent + user's own Gemini key).
- Natural-language → workflow graph (needs an LLM key; user-supplied).
- Store screenshots and a 60s demo video.
