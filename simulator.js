const http = require("node:http");
const fs = require("node:fs");
const WebSocket = require("ws");

const SAMPLE_INTERVAL_MS = 200;
const PORT = process.env.PORT || 3000;
const METERS_PER_NAUTICAL_MILE = 1852;
const METERS_PER_DEGREE_LATITUDE = 111320;

const allowedFaults = new Set(["motor_overheat", "battery_sag", "gps_drift"]);
const activeFaults = new Set();
const dashboardServer = http.createServer((request, response) => {
  if (request.method !== "GET" || (request.url !== "/" && request.url !== "/dashboard.html")) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  fs.readFile(`${__dirname}/dashboard.html`, (error, contents) => {
    if (error) {
      console.error("Failed to read dashboard.html:", error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Dashboard unavailable");
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    response.end(contents);
  });
});
const server = new WebSocket.Server({ server: dashboardServer });
dashboardServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard available at http://localhost:${PORT}`);
});

const state = {
  altitudeFt: 900,
  altitudeTargetFt: 900,
  airspeedKt: 110,
  airspeedTargetKt: 110,
  batteryPct: 100,
  windKt: 10,
  windTargetKt: 10,
  headingDeg: 35,
  headingTargetDeg: 35,
  motorRpm: [2150, 2160, 2145, 2155],
  motorTempsC: [68, 69, 68, 70],
  gpsLat: 27.9759,
  gpsLon: -82.5332,
};
const faultEffects = {
  motorOverheatExtraC: 0,
  motorRpmMultiplier: 1,
  batteryDrainMultiplier: 1,
  batteryVoltageSagV: 0,
  gpsDriftMeters: 0,
  gpsDriftBearingRadians: 0,
};
let breachEpisodeNumber = 0;
let activeBreachEpisode = null;

let lastUpdateMs = Date.now();
let nextTargetChangeMs = lastUpdateMs;

server.on("connection", (client) => {
  client.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      console.warn("Ignoring malformed WebSocket command:", error.message);
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      console.warn("Ignoring invalid WebSocket command.");
      return;
    }

    if (message.type === "clear_fault") {
      activeFaults.clear();
      console.log("All injected faults cleared.");
      return;
    }

    if (
      message.type !== "inject_fault" ||
      typeof message.fault !== "string" ||
      !allowedFaults.has(message.fault)
    ) {
      console.warn("Ignoring unknown WebSocket command or fault:", message.type, message.fault);
      return;
    }

    if (message.fault === "gps_drift" && !activeFaults.has(message.fault)) {
      faultEffects.gpsDriftBearingRadians = randomBetween(0, Math.PI * 2);
    }
    activeFaults.add(message.fault);
    console.log(`Injected fault: ${message.fault}`);
  });
});

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function approach(current, target, timeConstantSeconds, deltaSeconds) {
  return current + (target - current) * (1 - Math.exp(-deltaSeconds / timeConstantSeconds));
}

function update(deltaSeconds, nowMs) {
  if (nowMs >= nextTargetChangeMs) {
    state.altitudeTargetFt = randomBetween(650, 1250);
    state.airspeedTargetKt = randomBetween(95, 125);
    state.windTargetKt = randomBetween(5, 16);
    state.headingTargetDeg = (state.headingDeg + randomBetween(-18, 18) + 360) % 360;
    nextTargetChangeMs = nowMs + randomBetween(8000, 18000);
  }

  state.altitudeFt = approach(state.altitudeFt, state.altitudeTargetFt, 14, deltaSeconds);
  state.airspeedKt = approach(state.airspeedKt, state.airspeedTargetKt, 9, deltaSeconds);
  state.windKt = approach(state.windKt, state.windTargetKt, 12, deltaSeconds);

  const headingDifference = ((state.headingTargetDeg - state.headingDeg + 540) % 360) - 180;
  state.headingDeg = (state.headingDeg + headingDifference * (1 - Math.exp(-deltaSeconds / 20)) + 360) % 360;

  const baseRpm = 1850 + state.airspeedKt * 3.2;
  for (let i = 0; i < 4; i += 1) {
    const rpmTarget = baseRpm + (i - 1.5) * 12 + randomBetween(-8, 8);
    state.motorRpm[i] = approach(state.motorRpm[i], rpmTarget, 3, deltaSeconds);

    const temperatureTarget = 45 + state.motorRpm[i] * 0.012 + randomBetween(-1.5, 1.5);
    state.motorTempsC[i] = approach(state.motorTempsC[i], temperatureTarget, 25, deltaSeconds);
  }

  const overheatActive = activeFaults.has("motor_overheat");
  const maximumOverheatExtraC = Math.max(0, 125 - state.motorTempsC[2]);
  faultEffects.motorOverheatExtraC = overheatActive
    ? Math.min(maximumOverheatExtraC, faultEffects.motorOverheatExtraC + 2.5 * deltaSeconds)
    : Math.max(0, faultEffects.motorOverheatExtraC - 12 * deltaSeconds);
  faultEffects.motorRpmMultiplier = overheatActive
    ? 0.88
    : approach(faultEffects.motorRpmMultiplier, 1, 1.5, deltaSeconds);
  const batteryDrainTarget =
    (overheatActive ? 2 : 1) * (activeFaults.has("battery_sag") ? 10 : 1);
  faultEffects.batteryDrainMultiplier =
    batteryDrainTarget > 1
      ? batteryDrainTarget
      : approach(faultEffects.batteryDrainMultiplier, 1, 2, deltaSeconds);
  faultEffects.batteryVoltageSagV = activeFaults.has("battery_sag")
    ? 25
    : approach(faultEffects.batteryVoltageSagV, 0, 1.5, deltaSeconds);
  faultEffects.gpsDriftMeters = activeFaults.has("gps_drift")
    ? Math.min(300, faultEffects.gpsDriftMeters + 6 * deltaSeconds)
    : Math.max(0, faultEffects.gpsDriftMeters - 75 * deltaSeconds);
  state.batteryPct = Math.max(
    0,
    state.batteryPct - 0.012 * faultEffects.batteryDrainMultiplier * deltaSeconds,
  );

  const headingRadians = (state.headingDeg * Math.PI) / 180;
  const windSpeedKt = state.windKt * randomBetween(0.9, 1.1);
  const groundSpeedKt = state.airspeedKt + windSpeedKt * Math.cos(headingRadians);
  const distanceMeters = (groundSpeedKt * METERS_PER_NAUTICAL_MILE * deltaSeconds) / 3600;
  const latitudeRadians = (state.gpsLat * Math.PI) / 180;
  state.gpsLat += (distanceMeters * Math.cos(headingRadians)) / METERS_PER_DEGREE_LATITUDE;
  state.gpsLon +=
    (distanceMeters * Math.sin(headingRadians)) /
    (METERS_PER_DEGREE_LATITUDE * Math.cos(latitudeRadians));

  const driftLatitudeOffset =
    (faultEffects.gpsDriftMeters * Math.cos(faultEffects.gpsDriftBearingRadians)) /
    METERS_PER_DEGREE_LATITUDE;
  const driftLongitudeOffset =
    (faultEffects.gpsDriftMeters * Math.sin(faultEffects.gpsDriftBearingRadians)) /
    (METERS_PER_DEGREE_LATITUDE * Math.cos(latitudeRadians));

  return {
    timestamp: new Date(nowMs).toISOString(),
    heading_deg: Number(state.headingDeg.toFixed(1)),
    altitude_ft: Number(state.altitudeFt.toFixed(1)),
    airspeed_kt: Number(state.airspeedKt.toFixed(1)),
    battery_pct: Number(state.batteryPct.toFixed(2)),
    battery_voltage: Number((330 + state.batteryPct * 0.75 - faultEffects.batteryVoltageSagV).toFixed(1)),
    motor_temps_c: state.motorTempsC.map((temperature, index) =>
      Number((temperature + (index === 2 ? faultEffects.motorOverheatExtraC : 0)).toFixed(1)),
    ),
    motor_rpm: state.motorRpm.map((rpm, index) =>
      Math.round(rpm * (index === 2 ? faultEffects.motorRpmMultiplier : 1)),
    ),
    wind_kt: Number(state.windKt.toFixed(1)),
    gps_lat: Number((state.gpsLat + driftLatitudeOffset).toFixed(6)),
    gps_lon: Number((state.gpsLon + driftLongitudeOffset).toFixed(6)),
    active_faults: [...activeFaults],
    gps_drift_m: Math.round(faultEffects.gpsDriftMeters),
  };
}

function broadcast(message) {
  const messageJson = JSON.stringify(message);
  for (const client of server.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageJson);
    }
  }
}

function buildTemplateBriefing(snapshot) {
  const temperature = snapshot.temp_c;
  const severity = temperature >= 110 ? "CRITICAL" : "WARNING";
  const recommendedAction =
    temperature > 120
      ? "Initiate an immediate controlled landing and follow the approved emergency checklist."
      : temperature >= 110
        ? "Begin a controlled landing using the approved emergency checklist."
        : "Monitor the motor and prepare a controlled landing under the approved checklist.";
  const timeBudget =
    temperature > 120
      ? "Land within 2 minutes"
      : temperature >= 110
        ? "Land within 5 minutes"
        : "Land within 8 minutes";

  return {
    severity,
    summary: `Motor ${String(snapshot.motor).padStart(2, "0")} is at ${temperature.toFixed(1)}°C with ${Math.round(snapshot.rpm)} RPM; battery is ${snapshot.battery_pct.toFixed(1)}%.`,
    recommended_action: recommendedAction,
    time_budget: timeBudget,
  };
}

function validateBriefing(briefing) {
  if (
    !briefing ||
    !["WARNING", "CRITICAL"].includes(briefing.severity) ||
    typeof briefing.summary !== "string" ||
    typeof briefing.recommended_action !== "string" ||
    typeof briefing.time_budget !== "string" ||
    briefing.summary.trim().split(/\s+/).length > 25 ||
    briefing.recommended_action.trim().split(/\s+/).length > 20 ||
    !briefing.summary.trim() ||
    !briefing.recommended_action.trim() ||
    !briefing.time_budget.trim()
  ) {
    throw new Error("Gemini returned an invalid operator briefing.");
  }

  return {
    severity: briefing.severity,
    summary: briefing.summary.trim(),
    recommended_action: briefing.recommended_action.trim(),
    time_budget: briefing.time_budget.trim(),
  };
}

async function createOperatorBriefing(snapshot) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || typeof fetch !== "function") {
    return { briefing: buildTemplateBriefing(snapshot), source: "template" };
  }

  try {
    const prompt = [
      "You are an aviation operations safety analyst. Given the snapshot, return ONLY JSON with this shape:",
      '{"severity":"WARNING" or "CRITICAL","summary":"plain-English what is wrong, max 25 words","recommended_action":"imperative instruction, max 20 words","time_budget":"like Land within 6 minutes"}',
      "Use these time-budget guides: 100–110°C ≈ 8 minutes, 110–120°C ≈ 5 minutes, above 120°C ≈ 2 minutes. Do not return markdown or additional properties.",
      `Snapshot: ${JSON.stringify(snapshot)}`,
    ].join("\n");
    const models = ["gemini-3.6-flash", "gemini-flash-latest"];
    for (const model of models) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.4,
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
            signal: controller.signal,
          },
        );
        if (response.status === 404) {
          console.log(`Model ${model} unavailable, trying next`);
          continue;
        }
        if (!response.ok) throw new Error(`Gemini request failed with status ${response.status}.`);
        const result = await response.json();
        const parts = result.candidates?.[0]?.content?.parts;
        const text = Array.isArray(parts)
          ? parts
              .filter((part) => part?.thought !== true && typeof part?.text === "string")
              .map((part) => part.text)
              .join("")
          : "";
        if (!text) throw new Error("Gemini response did not contain briefing JSON.");
        return { briefing: validateBriefing(JSON.parse(text)), source: `Gemini (${model})` };
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("All Gemini models are unavailable.");
  } catch (error) {
    console.error("Gemini briefing failed:", error.message);
    return { briefing: buildTemplateBriefing(snapshot), source: "template" };
  }
}

function observeBreach(telemetry) {
  const motorIndex = telemetry.motor_temps_c.findIndex((temperature) => temperature > 100);
  if (motorIndex === -1) {
    activeBreachEpisode = null;
    return;
  }
  if (activeBreachEpisode !== null) return;

  const episode = ++breachEpisodeNumber;
  activeBreachEpisode = episode;
  const snapshot = {
    motor: motorIndex + 1,
    temp_c: telemetry.motor_temps_c[motorIndex],
    rpm: telemetry.motor_rpm[motorIndex],
    battery_pct: telemetry.battery_pct,
    altitude_ft: telemetry.altitude_ft,
    airspeed_kt: telemetry.airspeed_kt,
    wind_kt: telemetry.wind_kt,
  };

  void createOperatorBriefing(snapshot).then(({ briefing, source }) => {
    console.log(`Operator briefing source: ${source}`);
    if (activeBreachEpisode !== episode) return;
    broadcast({ type: "briefing", motor: snapshot.motor, briefing });
  });
}

setInterval(() => {
  const nowMs = Date.now();
  const deltaSeconds = Math.max(0, (nowMs - lastUpdateMs) / 1000);
  lastUpdateMs = nowMs;
  const telemetry = update(deltaSeconds, nowMs);
  const telemetryJson = JSON.stringify(telemetry);
  console.log(telemetryJson);
  for (const client of server.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(telemetryJson);
    }
  }
  observeBreach(telemetry);
}, SAMPLE_INTERVAL_MS);
