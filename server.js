import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import mqtt from "mqtt";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.warn("WARNING: Set JWT_SECRET to a random secret of at least 32 characters in .env before deployment.");
}
const secret = JWT_SECRET || "development-only-secret-change-this-32chars";
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const DEVICE_ID = process.env.MQTT_DEVICE_ID || "field-01";
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const defaultState = () => ({
  users: [], readings: [], events: [], settings: {
    crop: "Tomato", soilMoistureMin: 35, soilMoistureMax: 65,
    fieldName: "My Farm", fieldArea: 1, waterTankPercent: 80,
    pumpRunning: false, irrigationMode: "recommend", flowRateLpm: 0,
    totalWaterLitres: 0, deviceId: DEVICE_ID, lastDeviceSeen: null
  },
  plans: [], commands: []
});
await fs.mkdir(DATA_DIR, { recursive: true });
try { await fs.access(DB_FILE); } catch { await fs.writeFile(DB_FILE, JSON.stringify(defaultState(), null, 2)); }
let writeChain = Promise.resolve();
async function readDB() { return JSON.parse(await fs.readFile(DB_FILE, "utf8")); }
async function mutateDB(fn) {
  let result;
  writeChain = writeChain.then(async () => {
    const db = await readDB();
    result = await fn(db);
    await fs.writeFile(DB_FILE + ".tmp", JSON.stringify(db, null, 2));
    await fs.rename(DB_FILE + ".tmp", DB_FILE);
  });
  await writeChain;
  return result;
}
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  try { req.user = jwt.verify(token, secret); next(); }
  catch { res.status(401).json({ error: "Sign in to continue." }); }
}
function safeUser(u) { return { id: u.id, email: u.email, name: u.name }; }
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "64kb" }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "UZHAVAN AI", time: new Date().toISOString() }));
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "") || typeof password !== "string" || password.length < 10) {
    return res.status(400).json({ error: "Enter your name, valid email, and password with at least 10 characters." });
  }
  try {
    const user = await mutateDB(async db => {
      if (db.users.some(u => u.email === email.toLowerCase())) throw new Error("EMAIL_EXISTS");
      const u = { id: crypto.randomUUID(), name: name.trim().slice(0, 80), email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 12), createdAt: new Date().toISOString() };
      db.users.push(u); return safeUser(u);
    });
    res.json({ token: jwt.sign({ id: user.id, email: user.email }, secret, { expiresIn: "7d" }), user });
  } catch (e) { res.status(e.message === "EMAIL_EXISTS" ? 409 : 500).json({ error: e.message === "EMAIL_EXISTS" ? "Email already registered. Sign in instead." : "Could not create account." }); }
});
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const db = await readDB(); const u = db.users.find(x => x.email === String(email || "").toLowerCase());
  if (!u || !(await bcrypt.compare(password || "", u.passwordHash))) return res.status(401).json({ error: "Email or password is incorrect." });
  res.json({ token: jwt.sign({ id: u.id, email: u.email }, secret, { expiresIn: "7d" }), user: safeUser(u) });
});
app.get("/api/me", auth, async (req, res) => {
  const db = await readDB(); const u = db.users.find(x => x.id === req.user.id);
  if (!u) return res.status(401).json({ error: "Account not found." }); res.json({ user: safeUser(u) });
});

function calculateStatus(reading, settings) {
  const alerts = [];
  if (Number(reading.soilMoisture) < Number(settings.soilMoistureMin)) alerts.push({ type: "water", severity: "warning", message: `Soil is dry (${reading.soilMoisture}%). Consider irrigation.` });
  if (Number(reading.tankPercent) <= 15) alerts.push({ type: "tank", severity: "critical", message: "Water tank is low. Pump start is blocked by the software safety check." });
  if (reading.pumpRunning && Number(reading.flowRateLpm) < 0.2) alerts.push({ type: "flow", severity: "critical", message: "Pump reports running but flow is near zero. Check a blocked pipe, dry source, or flow sensor." });
  if (!reading.pumpRunning && Number(reading.flowRateLpm) > 1) alerts.push({ type: "leak", severity: "critical", message: "Flow detected while pump is off. Possible leak or sensor calibration issue." });
  if (Number(reading.flowRateLpm) > 30) alerts.push({ type: "flow", severity: "warning", message: "Unexpectedly high flow detected. Inspect pipes and calibrate the flow sensor." });
  return alerts;
}
app.get("/api/dashboard", auth, async (req, res) => {
  const db = await readDB(); const s = db.settings;
  const recent = db.readings.slice(-50).reverse();
  const latest = recent[0] || null;
  res.json({
    settings: s, latest, readings: recent,
    events: db.events.slice(-30).reverse(),
    alerts: latest ? calculateStatus(latest, s) : [{ type: "device", severity: "warning", message: "No sensor data yet. Connect ESP32 or submit a reading to start." }],
    plans: db.plans.slice(-10).reverse(),
    deviceOnline: !!(s.lastDeviceSeen && Date.now() - new Date(s.lastDeviceSeen).getTime() < 120000),
    mode: s.irrigationMode
  });
});
app.patch("/api/settings", auth, async (req, res) => {
  const b = req.body || {};
  const allowedCrops = ["Rice", "Tomato", "Cotton", "Maize", "Groundnut", "Sugarcane", "Chilli", "Banana", "Other"];
  const s = await mutateDB(db => {
    if (b.crop && allowedCrops.includes(b.crop)) db.settings.crop = b.crop;
    if (b.fieldName) db.settings.fieldName = String(b.fieldName).slice(0, 80);
    if (Number.isFinite(Number(b.fieldArea)) && Number(b.fieldArea) > 0 && Number(b.fieldArea) < 100000) db.settings.fieldArea = Number(b.fieldArea);
    if (Number.isFinite(Number(b.soilMoistureMin))) db.settings.soilMoistureMin = Math.max(5, Math.min(90, Number(b.soilMoistureMin)));
    if (Number.isFinite(Number(b.soilMoistureMax))) db.settings.soilMoistureMax = Math.max(db.settings.soilMoistureMin + 1, Math.min(100, Number(b.soilMoistureMax)));
    if (["manual", "recommend", "automatic"].includes(b.irrigationMode)) db.settings.irrigationMode = b.irrigationMode;
    return db.settings;
  });
  res.json({ settings: s });
});

// ESP32 device key is separate from farmer login. Set DEVICE_API_KEY in .env and send x-device-key.
app.post("/api/device/readings", async (req, res) => {
  const deviceKey = process.env.DEVICE_API_KEY;
  if (!deviceKey || req.headers["x-device-key"] !== deviceKey) return res.status(401).json({ error: "Device authentication failed. Set DEVICE_API_KEY and send x-device-key." });
  const b = req.body || {};
  const fields = ["soilMoisture", "temperatureC", "humidityPercent", "tankPercent", "flowRateLpm"];
  for (const f of fields) if (b[f] !== undefined && (!Number.isFinite(Number(b[f])) || Number(b[f]) < 0 || Number(b[f]) > (f === "soilMoisture" || f === "humidityPercent" || f === "tankPercent" ? 100 : 1000))) return res.status(400).json({ error: `Invalid ${f}` });
  const reading = await saveReading(b, "esp32");
  res.json({ accepted: true, reading });
});
async function saveReading(b, source = "web") {
  const reading = {
    id: crypto.randomUUID(), at: new Date().toISOString(), source,
    soilMoisture: Number(b.soilMoisture ?? 0), temperatureC: Number(b.temperatureC ?? 0),
    humidityPercent: Number(b.humidityPercent ?? 0), tankPercent: Number(b.tankPercent ?? 0),
    flowRateLpm: Number(b.flowRateLpm ?? 0), pumpRunning: Boolean(b.pumpRunning),
    rainfallMm: Number(b.rainfallMm ?? 0), voltage: Number(b.voltage ?? 0)
  };
  await mutateDB(db => {
    const previous = db.readings.at(-1);
    db.readings.push(reading); db.readings = db.readings.slice(-5000);
    db.settings.waterTankPercent = reading.tankPercent;
    db.settings.flowRateLpm = reading.flowRateLpm;
    db.settings.pumpRunning = reading.pumpRunning;
    db.settings.lastDeviceSeen = reading.at;
    if (reading.pumpRunning && reading.flowRateLpm > 0) db.settings.totalWaterLitres += reading.flowRateLpm / 60 * 5; // approx for a 5-second report interval; tune to firmware interval
    const alerts = calculateStatus(reading, db.settings);
    for (const a of alerts) db.events.push({ id: crypto.randomUUID(), at: reading.at, ...a });
    if (previous && !previous.pumpRunning && reading.flowRateLpm > 1) db.events.push({ id: crypto.randomUUID(), at: reading.at, type: "leak", severity: "critical", message: "Flow began while pump is off: possible leak." });
    db.events = db.events.slice(-1000);
  });
  return reading;
}
app.post("/api/readings/manual", auth, async (req, res) => {
  const b = req.body || {};
  for (const f of ["soilMoisture", "temperatureC", "humidityPercent", "tankPercent", "flowRateLpm"]) if (!Number.isFinite(Number(b[f]))) return res.status(400).json({ error: `Enter a valid ${f}` });
  res.json({ reading: await saveReading(b, "farmer-entered") });
});

const cropThresholds = {
  Rice: { min: 45, max: 75, water: "Rice needs careful water-level management; avoid continuous flooding where alternate wetting and drying is appropriate." },
  Tomato: { min: 35, max: 65, water: "Keep root-zone moisture consistent; avoid waterlogging and large dry/wet swings." },
  Cotton: { min: 30, max: 60, water: "Prioritize irrigation around flowering and boll development; avoid waterlogging." },
  Maize: { min: 35, max: 65, water: "Protect moisture during tasseling and silking, when water stress can reduce yield." },
  Groundnut: { min: 30, max: 60, water: "Avoid waterlogging; moisture is especially important during pegging and pod filling." },
  Sugarcane: { min: 40, max: 70, water: "Use frequent, measured irrigation in hot periods; check soil type and growth stage." },
  Chilli: { min: 35, max: 65, water: "Maintain even root-zone moisture and avoid overwatering." },
  Banana: { min: 40, max: 70, water: "Banana often needs frequent moisture; adjust for soil and local rainfall." },
  Other: { min: 35, max: 65, water: "Use local agricultural guidance to set crop-specific thresholds." }
};
app.get("/api/weather", auth, async (_req, res) => {
  const lat = Number(process.env.FIELD_LAT || 13.0827), lon = Number(process.env.FIELD_LON || 80.2707);
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&hourly=precipitation_probability&forecast_days=1&timezone=auto`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("weather service error");
    const data = await r.json();
    res.json({ source: "Open-Meteo", latitude: lat, longitude: lon, current: data.current, rainProbabilityNextHours: data.hourly?.precipitation_probability?.slice(0, 6) || [] });
  } catch { res.status(502).json({ error: "Weather service is unavailable. Check internet and configured FIELD_LAT/FIELD_LON." }); }
});
app.post("/api/irrigation/recommend", auth, async (req, res) => {
  const db = await readDB(); const s = db.settings;
  const latest = db.readings.at(-1);
  if (!latest) return res.status(409).json({ error: "No sensor reading yet. Connect your ESP32 or enter a real reading first." });
  const crop = s.crop; const t = cropThresholds[crop] || cropThresholds.Other;
  let weather = null, rainProbability = 0, weatherNote = "Weather not available; recommendation uses current sensor data only.";
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${Number(process.env.FIELD_LAT || 13.0827)}&longitude=${Number(process.env.FIELD_LON || 80.2707)}&hourly=precipitation_probability,precipitation&forecast_days=1&timezone=auto`;
    const wr = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (wr.ok) { weather = await wr.json(); rainProbability = Math.max(...(weather.hourly?.precipitation_probability?.slice(0, 6) || [0])); if (rainProbability >= 60) weatherNote = `Rain is likely in the next hours (${rainProbability}% peak probability); delay irrigation and re-check sensors.`; else weatherNote = `No strong near-term rain signal (${rainProbability}% peak probability in next hours).`; }
  } catch {}
  const soil = Number(latest.soilMoisture);
  let shouldWater = soil < t.min && rainProbability < 60;
  let duration = shouldWater ? Math.min(20, Math.max(2, Math.round((t.min - soil) * 0.4))) : 0;
  let reason = shouldWater ? `Soil moisture ${soil}% is below the configured ${crop} threshold (${t.min}%).` : (soil >= t.min ? `Soil moisture ${soil}% is above the ${crop} minimum (${t.min}%).` : "Rain probability is high, so irrigation is deferred.");
  const safety = [];
  if (Number(latest.tankPercent) <= 15) { shouldWater = false; duration = 0; safety.push("Tank level is at or below 15%; pump start is blocked."); }
  if (latest.pumpRunning && Number(latest.flowRateLpm) < 0.2) safety.push("Pump/flow mismatch: inspect source, pump and flow sensor.");
  if (!latest.pumpRunning && Number(latest.flowRateLpm) > 1) { shouldWater = false; duration = 0; safety.push("Unexpected flow with pump off; possible leak, so no pump command is issued."); }
  let aiExplanation = null;
  if (client) {
    try {
      const response = await client.chat.completions.create({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", temperature: 0.2, messages: [
        { role: "system", content: "You are a cautious agricultural assistant. Explain the provided rule-based irrigation result in simple English and Tamil. Do not change safety decisions, invent sensor values, or issue pump commands. Mention recommendations are advisory and thresholds need local calibration. Return concise plain text." },
        { role: "user", content: JSON.stringify({ crop, latest, threshold: t, rainProbability, weatherNote, shouldWater, durationMinutes: duration, reason, safety }) }
      ]});
      aiExplanation = response.choices[0]?.message?.content || null;
    } catch { aiExplanation = "AI API could not be reached; the transparent crop-rule recommendation is still shown."; }
  }
  const plan = { id: crypto.randomUUID(), at: new Date().toISOString(), crop, soilMoisture: soil, shouldWater, durationMinutes: duration, reason, cropGuidance: t.water, weatherNote, rainProbability, safety, aiExplanation, status: "recommendation-only" };
  await mutateDB(d => { d.plans.push(plan); d.plans = d.plans.slice(-200); });
  res.json({ plan, aiEnabled: !!client });
});
app.post("/api/irrigation/command", auth, async (req, res) => {
  const action = req.body?.action;
  if (!["start", "stop"].includes(action)) return res.status(400).json({ error: "Action must be start or stop." });
  if (action === "start") {
    const db = await readDB(); const latest = db.readings.at(-1);
    if (!latest) return res.status(409).json({ error: "Cannot start: no sensor readings." });
    if (Number(latest.tankPercent) <= 15) return res.status(409).json({ error: "Pump start blocked: tank level is at or below 15%." });
    if (!process.env.ALLOW_LIVE_PUMP_CONTROL || process.env.ALLOW_LIVE_PUMP_CONTROL !== "true") return res.status(403).json({ error: "Live pump control is disabled. Test physical low-water, dry-run, overload and emergency-stop protections first; then set ALLOW_LIVE_PUMP_CONTROL=true." });
  }
  if (!mqttClient?.connected) return res.status(503).json({ error: "No MQTT broker connected. No hardware command was sent." });
  const payload = { deviceId: DEVICE_ID, action, requestedAt: new Date().toISOString(), requestId: crypto.randomUUID() };
  mqttClient.publish(`uzhavan/${DEVICE_ID}/command`, JSON.stringify(payload), { qos: 1 }, async err => {
    if (err) return res.status(502).json({ error: "MQTT publish failed; command not confirmed." });
    await mutateDB(db => { db.commands.push({ ...payload, status: "sent-not-confirmed" }); db.commands = db.commands.slice(-200); });
    res.json({ accepted: true, command: payload, note: "Command sent to MQTT broker, not confirmation that the pump changed state. Wait for device telemetry/acknowledgement." });
  });
});

app.post("/api/farm/analyze", auth, async (req, res) => {
  const b = req.body || {};
  const required = ["crop", "soilMoisture", "temperatureC", "humidityPercent", "waterAvailableLitres", "fieldAreaAcres", "irrigationDurationMinutes", "flowRateLpm", "pumpRunning", "rainProbabilityPercent"];
  for (const f of required) {
    if (b[f] === undefined || b[f] === null || b[f] === "") return res.status(400).json({ error: `Please enter ${f}.` });
  }
  const numeric = ["soilMoisture", "temperatureC", "humidityPercent", "waterAvailableLitres", "fieldAreaAcres", "irrigationDurationMinutes", "flowRateLpm", "rainProbabilityPercent", "waterUsedLitres", "minimumWaterLitres"];
  for (const f of numeric) {
    if (b[f] !== undefined && b[f] !== "" && !Number.isFinite(Number(b[f]))) return res.status(400).json({ error: `${f} must be a number.` });
  }
  const soil = Number(b.soilMoisture), temp = Number(b.temperatureC), humidity = Number(b.humidityPercent);
  const tank = Number(b.waterAvailableLitres), area = Number(b.fieldAreaAcres), duration = Number(b.irrigationDurationMinutes);
  const flow = Number(b.flowRateLpm), manualRain = Number(b.rainProbabilityPercent), used = Number(b.waterUsedLitres !== undefined && b.waterUsedLitres !== "" ? b.waterUsedLitres : flow * duration);
  const minWater = Number(b.minimumWaterLitres ?? 100);
  if (soil < 0 || soil > 100 || humidity < 0 || humidity > 100 || manualRain < 0 || manualRain > 100 || tank < 0 || area <= 0 || duration < 0 || flow < 0 || used < 0 || minWater < 0) return res.status(400).json({ error: "Check values: percentages must be 0–100, and water/area/time values cannot be negative." });
  const crop = String(b.crop);
  const thresholds = {
    Rice: { min: 45, max: 75, litresPerAcrePerMinute: 0, advice: "Rice water management depends strongly on growth stage and field method. Consider alternate wetting and drying only when locally appropriate." },
    Tomato: { min: 35, max: 65, litresPerAcrePerMinute: 0, advice: "Keep root-zone moisture steady and avoid waterlogging. Drip irrigation can reduce evaporation." },
    Cotton: { min: 30, max: 60, litresPerAcrePerMinute: 0, advice: "Prioritize moisture during flowering and boll development; avoid waterlogging." },
    Maize: { min: 35, max: 65, litresPerAcrePerMinute: 0, advice: "Avoid moisture stress around tasseling and silking." },
    Groundnut: { min: 30, max: 60, litresPerAcrePerMinute: 0, advice: "Avoid waterlogging, especially around pegging and pod development." },
    Sugarcane: { min: 40, max: 70, litresPerAcrePerMinute: 0, advice: "Adjust frequency to soil, growth stage and heat; check for seepage and runoff." },
    Chilli: { min: 35, max: 65, litresPerAcrePerMinute: 0, advice: "Aim for consistent root moisture and avoid excess irrigation." },
    Banana: { min: 40, max: 70, litresPerAcrePerMinute: 0, advice: "Banana can need frequent irrigation; adjust for soil and local weather." },
    Other: { min: 35, max: 65, litresPerAcrePerMinute: 0, advice: "Use local agricultural extension guidance to set thresholds for this crop." }
  };
  const t = thresholds[crop] || thresholds.Other;
  // Use live forecast when reachable, but always fall back to the farmer-entered rain probability.
  let forecastRain = null;
  try {
    const lat = Number(process.env.FIELD_LAT || 13.0827), lon = Number(process.env.FIELD_LON || 80.2707);
    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_probability&forecast_days=1&timezone=auto`;
    const wr = await fetch(forecastUrl, { signal: AbortSignal.timeout(3500) });
    if (wr.ok) {
      const forecast = await wr.json();
      const values = forecast.hourly?.precipitation_probability?.slice(0, 6)?.filter(Number.isFinite) || [];
      if (values.length) forecastRain = Math.max(...values);
    }
  } catch {}
  const rain = forecastRain === null ? manualRain : Math.max(manualRain, forecastRain);
  const alerts = [];
  if (tank <= minWater) alerts.push({ severity: "critical", title: "Low water availability", detail: `Available water (${tank} L) is at or below your minimum threshold (${minWater} L). Avoid irrigation until supply is restored.` });
  if (Boolean(b.pumpRunning) && flow <= 0.2) alerts.push({ severity: "critical", title: "Possible pump/flow issue", detail: "Pump is entered as ON but flow is near zero. Check the pump, valve, source and the values entered." });
  if (!Boolean(b.pumpRunning) && flow > 1) alerts.push({ severity: "critical", title: "Possible leak or unaccounted flow", detail: "Flow is entered above 1 L/min while pump status is OFF. Check for leaks, gravity flow, or an incorrect input." });
  if (flow > 30) alerts.push({ severity: "warning", title: "High flow rate", detail: "The entered flow rate is high. Compare with your pipe and emitter design; excess flow can waste water." });
  if (used > tank && tank >= 0) alerts.push({ severity: "warning", title: "Water demand exceeds availability", detail: `Entered/estimated use (${used.toFixed(1)} L) is greater than available water (${tank.toFixed(1)} L).` });
  if (temp >= 35 && humidity < 35) alerts.push({ severity: "warning", title: "Hot and dry conditions", detail: "High temperature with low humidity may increase crop water demand. Check local forecast and soil again." });
  const shouldIrrigate = soil < t.min && rain < 60 && tank > minWater;
  const durationSuggestion = shouldIrrigate ? Math.min(30, Math.max(3, Math.round((t.min - soil) * 0.5))) : 0;
  let decision = shouldIrrigate ? "Irrigation may be needed" : "Do not irrigate yet";
  let reasons = [];
  if (soil < t.min) reasons.push(`Soil moisture (${soil}%) is below the starting ${crop} threshold (${t.min}%).`);
  else reasons.push(`Soil moisture (${soil}%) is at or above the starting ${crop} threshold (${t.min}%).`);
  if (rain >= 60) reasons.push(`Rain probability is high (${rain}%); delay irrigation and re-check conditions.`);
  if (tank <= minWater) reasons.push("Available water is at/below your minimum water threshold.");
  const estimatedWater = Number(b.waterUsedLitres !== undefined && b.waterUsedLitres !== "" ? b.waterUsedLitres : flow * duration);
  const output = {
    inputSummary: { crop, soilMoisture: soil, temperatureC: temp, humidityPercent: humidity, waterAvailableLitres: tank, fieldAreaAcres: area, rainProbabilityPercent: rain, irrigationDurationMinutes: duration, flowRateLpm: flow, pumpRunning: Boolean(b.pumpRunning), estimatedWaterUsedLitres: estimatedWater },
    irrigation: { decision, shouldIrrigate, suggestedDurationMinutes: durationSuggestion, reason: reasons.join(" "), cropGuidance: t.advice, estimatedLitresForEnteredDuration: Math.round(flow * duration * 10) / 10 },
    water: { availableLitres: tank, estimatedUsedLitres: estimatedWater, estimatedRemainingLitres: Math.max(0, tank - estimatedWater), minimumLitres: minWater, percentageOfAvailabilityUsed: tank > 0 ? Math.min(100, Math.round(estimatedWater / tank * 1000) / 10) : null },
    alerts,
    summary: `${crop}: ${decision}. ${reasons.join(" ")}`,
    weather: { manualRainProbabilityPercent: manualRain, forecastRainProbabilityPercent: forecastRain, rainProbabilityPercentUsed: rain, source: forecastRain === null ? "farmer-entered forecast (live forecast unavailable)" : "Open-Meteo live forecast combined conservatively with farmer input", effect: rain >= 60 ? `Rain probability used for this plan is ${rain}%${forecastRain === null ? " from your entered value" : ` (live forecast peak ${forecastRain}%)`}; consider delaying irrigation and re-checking soil.` : `Rain probability used for this plan is ${rain}%. Check local conditions before irrigation.` },
    generatedAt: new Date().toISOString()
  };
  if (client) {
    try {
      const ai = await client.chat.completions.create({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", temperature: 0.2, messages: [
        { role: "system", content: "You are UZHAVAN AI, a cautious farming assistant. Use only supplied farmer-entered values. Do not invent sensor data, forecast data, diagnoses, or guarantee yield. Keep the existing rule-based safety decision unchanged. Answer in English and Tamil briefly. State that crop thresholds are approximate and local agronomy should be consulted." },
        { role: "user", content: JSON.stringify(output) }
      ]});
      output.aiExplanation = ai.choices[0]?.message?.content || null;
    } catch { output.aiExplanation = "AI service unavailable; rule-based results are still available."; }
  } else {
    output.aiExplanation = "OpenAI API key is not configured. Results use transparent rule-based calculations, not generative AI.";
  }
  await mutateDB(db => {
    db.lastFarmAnalyses ||= {};
    db.lastFarmAnalyses[req.user.id] = { ...output, aiExplanation: undefined };
    db.events.push(...alerts.map(a => ({ id: crypto.randomUUID(), at: output.generatedAt, type: "manual-analysis", severity: a.severity, message: `${a.title}: ${a.detail}` })));
    db.events = db.events.slice(-1000);
    db.plans.push({ id: crypto.randomUUID(), at: output.generatedAt, crop, shouldWater: shouldIrrigate, durationMinutes: durationSuggestion, reason: output.summary, status: "manual-input-analysis" });
    db.plans = db.plans.slice(-200);
  });
  res.json(output);
});

app.post("/api/chat", auth, async (req, res) => {
  const message = String(req.body?.message || "").trim().slice(0, 1500);
  if (!message) return res.status(400).json({ error: "Enter a question." });
  const db = await readDB(); const latest = db.readings.at(-1); const crop = db.settings.crop;
  const manualAnalysis = db.lastFarmAnalyses?.[req.user.id] || null;
  if (client) {
    try {
      const out = await client.chat.completions.create({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", temperature: 0.3, messages: [
        { role: "system", content: `You are UZHAVAN AI, a cautious Tamil/English farming assistant. Answer in the user's language. Current saved crop setting: ${crop}. Latest manually entered reading: ${JSON.stringify(latest || "No separate reading form entry")}. Latest farm analysis submitted by this user: ${JSON.stringify(manualAnalysis || "No manual analysis submitted yet")}. Clearly distinguish manually entered estimates from sensor measurements. Never pretend sensor data exists. Do not claim to have operated hardware. For chemical/pesticide advice, encourage following product label and local extension guidance.` },
        { role: "user", content: message }
      ]});
      return res.json({ reply: out.choices[0]?.message?.content || "Could not create an answer.", provider: "OpenAI" });
    } catch {}
  }
  const analysisNote = manualAnalysis ? `Last manual analysis: ${manualAnalysis.summary} Water estimate: ${manualAnalysis.water.estimatedUsedLitres} L; available water entered: ${manualAnalysis.water.availableLitres} L.` : "No manual farm analysis has been submitted yet.";
  const reply = /தமிழ்|tamil|வணக்கம்|தண்ணீர்|பயிர்/i.test(message)
    ? `வணக்கம்! உங்கள் பயிர்: ${crop}. ${manualAnalysis ? `நீங்கள் உள்ளிட்ட கடைசி விவசாயத் தரவு: ${manualAnalysis.summary}` : latest ? `கடைசியாக உள்ளிட்ட மண் ஈரப்பதம் ${latest.soilMoisture}%, தொட்டி அளவு ${latest.tankPercent}%.` : "இன்னும் விவசாயத் தரவு உள்ளிடப்படவில்லை."} இது ஆலோசனை மட்டுமே; உள்ளூர் வேளாண் வழிகாட்டுதலைப் பின்பற்றவும்.`
    : `I can provide a basic local answer, but OPENAI_API_KEY is not configured. Current crop setting: ${crop}. ${analysisNote} ${latest ? `Latest separately saved reading: soil ${latest.soilMoisture}%, tank ${latest.tankPercent}%.` : "No separate manual reading has been saved."} Add OPENAI_API_KEY for generative AI responses.`;
  res.json({ reply, provider: "local-fallback" });
});

let mqttClient = null;
if (process.env.MQTT_URL) {
  mqttClient = mqtt.connect(process.env.MQTT_URL, { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD, reconnectPeriod: 3000 });
  mqttClient.on("connect", () => {
    console.log("MQTT connected");
    mqttClient.subscribe(`uzhavan/${DEVICE_ID}/telemetry`, { qos: 1 });
    mqttClient.subscribe(`uzhavan/${DEVICE_ID}/ack`, { qos: 1 });
  });
  mqttClient.on("message", async (topic, buf) => {
    try {
      const payload = JSON.parse(buf.toString());
      if (topic.endsWith("/telemetry")) await saveReading(payload, "esp32-mqtt");
      else if (topic.endsWith("/ack")) await mutateDB(db => { db.commands.push({ ...payload, receivedAt: new Date().toISOString(), status: "device-ack" }); db.commands = db.commands.slice(-200); });
    } catch (e) { console.error("Bad MQTT message", e.message); }
  });
}
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API route not found." });
  res.sendFile(path.join(__dirname, "public", "index.html"), err => err && next(err));
});
app.listen(PORT, () => console.log(`UZHAVAN AI running at http://localhost:${PORT}`));
