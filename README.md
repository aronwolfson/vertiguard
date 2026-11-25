# VertiGuard

Real-time operations console for an electric air taxi (eVTOL) fleet — the ground-side monitoring screen for Advanced Air Mobility.

**Live demo:** https://vertiguard-195829893468.us-central1.run.app

VertiGuard watches a live telemetry stream from an aircraft in flight. The moment any monitored value crosses a safety limit, the operator gets an audible alarm, a popup notification, and a plain-English briefing written by an LLM: what is wrong, how severe it is, what to do, and how much time is left to do it. It is modeled on the network operations centers that real air-taxi operators will use to supervise fleets of aircraft from the ground.

No passenger air taxis are flying yet, so VertiGuard ships with a physics-based flight simulator that generates the telemetry. The dashboard is the product; the simulator is the aircraft stand-in.

## What it does

- Streams live telemetry at 5 Hz: altitude, airspeed, battery charge and voltage, four motor temperatures and RPMs, wind, GPS position and heading
- Continuous threshold monitoring on every value (motor temperature, battery level, GPS integrity)
- One-click fault injection for demonstrations: motor overheat, battery sag, GPS drift
- LLM operator briefings on every safety breach, with a rules-based template fallback if the API is unreachable
- Warbling audible alarm (repeats until acknowledged), OS-level popup notifications, and a permanent event log as the incident record
- Live map with dark and satellite basemaps, a heading-rotating aircraft marker, and a ground-track trail

## Architecture

One Node.js process serves everything on a single port:

```
simulator.js ── telemetry JSON, 5×/s ──▶ WebSocket ──▶ dashboard.html
     │                                                        │
     └── threshold breach ──▶ Gemini API ──▶ briefing JSON ───┘
```

- `simulator.js` generates telemetry with physics-style smoothing (values ease toward drifting targets; GPS position is integrated from heading and ground speed), serves `dashboard.html`, and broadcasts every sample to all connected browsers over one WebSocket.
- The dashboard renders the stream: Leaflet map, system values, motor grid, alerts, event log.
- The server (never the browser) watches the stream for threshold crossings. On a breach it sends a telemetry snapshot to Gemini and broadcasts the returned briefing — severity, summary, recommended action, time budget — to the dashboard. The API key exists only in the server's environment.

## Run it locally

Requires Node.js 18 or newer.

```
npm install
npm start
```

Open http://localhost:3000.

To enable live Gemini briefings, get a free API key from [Google AI Studio](https://aistudio.google.com/apikey) and start the server with it in the environment:

```
GEMINI_API_KEY=your-key npm start
```

Never commit the key to the repository. Without a key, VertiGuard still works: briefings come from a built-in rules-based template instead. The server console prints which source produced each briefing (`Operator briefing source: Gemini (…)` or `template`).

## Run the demo

1. Click **ARM SOUND** (browsers require one click before audio can play) and **ENABLE ALERTS** if you want OS notifications.
2. In **Simulator controls**, click **INJECT MOTOR OVERHEAT**.
3. Watch MTR 03's temperature climb about 2.5 °C per second. At 100 °C the alarm sounds, the event log starts pulsing, and the operator briefing panel fills in with Gemini's assessment.
4. Click the alert to acknowledge it and silence the alarm. **CLEAR FAULT** ends the episode and the log records the recovery.

The other faults: **BATTERY SAG** drops bus voltage by 25 V and drains the battery ten times faster; **GPS DRIFT** walks the reported position away from the true position, and past 100 m of drift the dashboard flags the position readout as unreliable.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on (set automatically by Cloud Run) |
| `GEMINI_API_KEY` | — | Optional. Enables live LLM briefings; template fallback without it |

## Deployment

VertiGuard is built to deploy as a single container on Google Cloud Run — one process, one port, WebSocket included:

```
gcloud run deploy vertiguard --source . --allow-unauthenticated
```

Set `GEMINI_API_KEY` as an environment variable on the service (Cloud Run console → Edit & deploy new revision → Variables). Do not bake it into the image or the repo.

## AI tools

Built with AI assistance. GitHub Copilot in VS Code was used as the coding agent during development. Operator briefings are generated at runtime by Google Gemini.

## License

MIT — see `LICENSE`.
