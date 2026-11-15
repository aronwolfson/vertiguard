const http = require("node:http");
const fs = require("node:fs");
const WebSocket = require("ws");

const SAMPLE_INTERVAL_MS = 200;
const PORT = 8080;
const HTTP_PORT = 3000;
const METERS_PER_NAUTICAL_MILE = 1852;
const METERS_PER_DEGREE_LATITUDE = 111320;

const server = new WebSocket.Server({ port: PORT });
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
dashboardServer.listen(HTTP_PORT, "127.0.0.1", () => {
  console.log(`Dashboard available at http://localhost:${HTTP_PORT}`);
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

let lastUpdateMs = Date.now();
let nextTargetChangeMs = lastUpdateMs;

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

  state.batteryPct = Math.max(0, state.batteryPct - 0.012 * deltaSeconds);

  const baseRpm = 1850 + state.airspeedKt * 3.2;
  for (let i = 0; i < 4; i += 1) {
    const rpmTarget = baseRpm + (i - 1.5) * 12 + randomBetween(-8, 8);
    state.motorRpm[i] = approach(state.motorRpm[i], rpmTarget, 3, deltaSeconds);

    const temperatureTarget = 45 + state.motorRpm[i] * 0.012 + randomBetween(-1.5, 1.5);
    state.motorTempsC[i] = approach(state.motorTempsC[i], temperatureTarget, 25, deltaSeconds);
  }

  const headingRadians = (state.headingDeg * Math.PI) / 180;
  const windSpeedKt = state.windKt * randomBetween(0.9, 1.1);
  const groundSpeedKt = state.airspeedKt + windSpeedKt * Math.cos(headingRadians);
  const distanceMeters = (groundSpeedKt * METERS_PER_NAUTICAL_MILE * deltaSeconds) / 3600;
  const latitudeRadians = (state.gpsLat * Math.PI) / 180;
  state.gpsLat += (distanceMeters * Math.cos(headingRadians)) / METERS_PER_DEGREE_LATITUDE;
  state.gpsLon +=
    (distanceMeters * Math.sin(headingRadians)) /
    (METERS_PER_DEGREE_LATITUDE * Math.cos(latitudeRadians));

  return {
    timestamp: new Date(nowMs).toISOString(),
    altitude_ft: Number(state.altitudeFt.toFixed(1)),
    airspeed_kt: Number(state.airspeedKt.toFixed(1)),
    battery_pct: Number(state.batteryPct.toFixed(2)),
    battery_voltage: Number((330 + state.batteryPct * 0.75).toFixed(1)),
    motor_temps_c: state.motorTempsC.map((temperature) => Number(temperature.toFixed(1))),
    motor_rpm: state.motorRpm.map((rpm) => Math.round(rpm)),
    wind_kt: Number(state.windKt.toFixed(1)),
    gps_lat: Number(state.gpsLat.toFixed(6)),
    gps_lon: Number(state.gpsLon.toFixed(6)),
  };
}

setInterval(() => {
  const nowMs = Date.now();
  const deltaSeconds = Math.max(0, (nowMs - lastUpdateMs) / 1000);
  lastUpdateMs = nowMs;
  const telemetryJson = JSON.stringify(update(deltaSeconds, nowMs));
  console.log(telemetryJson);
  for (const client of server.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(telemetryJson);
    }
  }
}, SAMPLE_INTERVAL_MS);
