# Caribbean Paradise Homes — "My Stay" (real app)

A guest web app that takes a **booking reference + lead-guest last name**, verifies it
against the **365Villas / GuestWisely** PMS, and shows only that guest's stay
(villa, dates, countdown, check-in, add-ons, concierge). No more demo data.

- **Backend + frontend in one tiny Node service** (zero npm dependencies — pure Node ≥18 stdlib).
- The 365Villas secrets live **only** on the server as environment variables — never in the browser.
- Ships with **mock mode** so it runs and is clickable before any credentials are wired.

```
my-stay-app/
  src/server.js      # HTTP server, auth/session, static hosting, API routes
  src/villas365.js   # 365Villas adapter (+ mock data) — all field names configurable
  public/index.html  # the guest app (single file, data-driven)
  .env.example       # all settings, documented
  render.yaml        # one-click Render blueprint
```

## Run it locally (mock data, no credentials)

```bash
cd my-stay-app
npm start            # or: node src/server.js
# open http://localhost:3000  → log in with  CDC-2026-0741 / Hartley
```
(`SESSION_SECRET=dev npm run dev` also works and sets mock mode for you.)

You can also just double-click **`preview-live-app.html`** (delivered separately) to
click through the UI with demo data — no server needed.

## Go live in 3 steps

### 1) Deploy the service (you own the host)
Easiest is **Render** (free tier):
1. Put this folder in a GitHub repo.
2. Render → **New → Blueprint** → pick the repo (it reads `render.yaml`).
3. It deploys to a URL like `https://cph-my-stay.onrender.com`.

(Any Node host works — Railway, Fly.io, a VPS. `npm start` is the only command.)

### 2) Add your secrets (only you ever hold these)
In the host's **Environment** settings, set:

| Variable | Value |
|---|---|
| `SESSION_SECRET` | a long random string (Render can auto-generate) |
| `V365_MOCK` | `0` |
| `V365_KEY` | from wp-admin → **Guestwisely** → *API Key* |
| `V365_PASS` | *API Password* |
| `V365_OWNER_TOKEN` | *API Owner Token* |
| `V365_USERNAME` | *API Owner Username* |

Redeploy. Visit `/healthz` — it should report `"mode":"live"`.

### 3) Confirm the API field mapping (5 minutes, one-time)
The exact 365Villas **action/field names** for "look up a booking by reference" live on
your account's gated **API & Integrations** page. The app uses sensible defaults
(`getbooking`, `bookingId`, `lastName`, …) that are **all overridable by env var** —
no code change. To confirm/adjust:

1. Set `V365_DEBUG=1` temporarily and try a real booking reference.
2. If a field comes back empty, open the API page in your PMS, find the real name,
   and set the matching `V365_*` env var (see `.env.example`). Redeploy.
3. Set `V365_DEBUG=0` again.

### 4) Point caribbeanparadisehomes.com/my-stay/ at it
Your `/my-stay/` page already renders via HFCM snippet **id 15**. To switch it from the
demo bundle to this live app, that snippet's iframe just changes from an embedded
`srcdoc` to `src="https://<your-deployed-url>"`. **Tell me the deployed URL and I'll
make that change and verify it** — or do it yourself in wp-admin → HFCM → snippet 15.

## What works now vs. next (Phase 2)
**Working:** guest login against real bookings, live villa/dates/countdown, the full guest
journey (Home, Stay, Explore, Concierge, pre-check-in, add-ons, arrival, checkout),
session security, and login rate-limiting.

**Phase 2 (stubbed, ready to wire):** the `/api/checkin`, `/api/addons`, `/api/message`
endpoints currently acknowledge submissions. Turning on the *live* pieces means:
real concierge messaging (WhatsApp Business/Twilio), secure passport upload + storage
with auto-deletion, add-on requests creating staff tasks, and Publish → auto-notify the
guest. The staff Concierge Console is a separate build. These are scoped in the project
handoff README.

## Security notes
- 365Villas credentials are server-side env vars only; the browser never sees them.
- Sessions are short-lived, signed (HMAC-SHA256), HttpOnly cookies.
- Login is rate-limited per IP. Only `Published` bookings can be opened.
- Passport upload is intentionally **not** accepted until secure storage + retention exist.
