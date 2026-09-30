# BotFleet

A Chrome extension plus a local backend that deploys a fleet of AI bots onto whatever page you're browsing. Each bot has a mission (summarize, check what a form needs, sanity-check a price, flag claims, suggest next steps…). One click, **Deploy all**, runs every matching bot in parallel. Their recommendations stream into the side panel, each with a one-click action.

Bots run on **your own Claude API key**. It's stored encrypted on your machine.

```
BotFleet/
├── server/        Node backend + web dashboard (http://localhost:4477)
│   ├── src/       API, Claude integration, encrypted secrets, JSON store
│   └── public/    Dashboard SPA (bots, activity, credentials, privacy, pairing)
├── extension/     Chrome MV3 extension (side panel, service worker, page extractor)
└── scripts/       Icon generator
```

## Quick start

1. **Start the backend** (Node 20+):
   ```bash
   cd server
   npm install
   npm start
   ```
2. **Add your AI credentials.** Open http://localhost:4477 → **AI credentials** → paste your Claude API key (from console.anthropic.com), then **Save key**. It's verified before it's saved. Alternatively, set `ANTHROPIC_API_KEY` before `npm start`.
3. **Install the extension.** Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder. Pin it.
4. **Pair.** In the dashboard, go to **Extension** → **Copy** the pairing code. Click the BotFleet icon and paste the code.
5. Open any website and hit **Deploy all bots** (or press `Alt+Shift+D`).

## How it works

- **Extension:** The side panel shows the current page, the bots that target it, and live results. The service worker owns each deployment, so a run keeps going if you close the panel. It caches results per tab and puts the recommendation count on the toolbar badge. `extract.js` is injected on demand and captures a compact page snapshot: text, headings, links, prices, page-type signals, your selection, and form field *labels and types*. Field values are never read.
- **Backend:** `POST /api/deploy` fans out to every enabled bot that targets the URL (with a concurrency limit) and streams NDJSON events back as each bot finishes. Each bot is one Claude call:
  - **Model:** `claude-opus-5-5` by default; switch to Sonnet 5.5 in the dashboard.
  - **Structured output:** JSON-schema responses, validated with zod.
  - **Caching:** the page snapshot is cache-marked, so bots on the same page share it.
  - **Fallback:** server-side refusal fallback (`fallbacks: "default"`), with a toggle in the dashboard.
- **Actions:** Each recommendation carries one action: open a link from the page, run a web search, copy text, or highlight a passage on the page. The model can't navigate anywhere itself. Non-http(s) URLs are downgraded to searches.
- **Auto-pilot (off by default):** When a page loads, bots marked *auto* scan it in the background, and the badge fills in. Results are reused for 30 minutes per URL.

## Security & privacy

| Concern | What BotFleet does |
|---|---|
| API key at rest | AES-256-GCM, with the master key in `server/data/.master.key` (0600). The dashboard and extension only see a masked hint. |
| Other websites calling your local server | Every `/api` route needs a bearer token (the pairing code). CORS only allows `chrome-extension://` origins. The server binds to `127.0.0.1` and rejects non-localhost `Host` headers (DNS-rebinding protection). |
| Sensitive sites | A blocklist, enforced by both the extension and the server. Defaults cover banks, PayPal, Google accounts and mail, password managers, and localhost. |
| Personal data in page text | Optional redaction of emails, phone numbers, and card-like or SSN-like numbers before anything is sent. On by default. |
| Prompt injection from pages | Page content is fenced and treated as untrusted data. Bots can only suggest the four constrained actions, and every action needs your click. |

Rotate the pairing code under **Extension → Rotate code**. Data lives in `server/data/` (delete it to reset everything).

## Building your own bots

In the dashboard, open **Bots → New bot**. A bot is:

- **Mission:** plain-English instructions. The output format and safety rules are added for you.
- **Targets:** URL globs, one per line: `*`, `github.com/*`, `*.shopify.com`, `docs.*`.
- **Effort:** `low` for fast and cheap, `high` for deep analysis.
- **Auto-pilot:** whether it runs on page load when auto-pilot is on.

## Configuration

| Env var | Default | |
|---|---|---|
| `BOTFLEET_PORT` | `4477` | If you change it, re-pair the extension (the code includes the URL). |
| `BOTFLEET_DATA` | `server/data` | Database, encrypted key, master key. |
| `ANTHROPIC_API_KEY` | — | Used when no key is stored in the dashboard. |

## Shortcuts

- `Alt+Shift+D`: deploy all bots on the current page
- `Alt+Shift+F`: open the side panel
- Right-click → **Deploy bots on "…"**: run the fleet with your selected text in focus

Rebind them at `chrome://extensions/shortcuts`.
