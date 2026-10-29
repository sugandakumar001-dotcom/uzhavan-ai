# UZHAVAN AI — Web-input smart farming website

This website is designed to work from farmer-entered values. **No ESP32, physical sensor, MQTT broker, relay or wiring is required.**

## Run locally on Mac / VS Code

1. Install Node.js 20 or newer.
2. Open this folder in VS Code.
3. In Terminal → New Terminal:

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Copy the generated random string into `.env` as `JWT_SECRET=...`. Keep `.env` private.

```bash
npm install
npm start
```

Open http://localhost:3000 and create an account.

## How to use the website

1. Create your account or sign in.
2. Enter field name, crop, area and soil moisture thresholds.
3. Enter soil moisture, temperature, humidity, tank level, flow rate and the observed pump status in **Enter your farm readings**.
4. Save the reading. The dashboard, trend, water estimate, low-water alerts and leak/waste alerts update from your inputs.
5. Choose **Get irrigation plan** or **Calculate plan**; both now analyze the values in the manual farm form and do not require a saved sensor reading. The analysis uses your entered rain probability and, when reachable, a live Open-Meteo forecast.
6. Ask the UZHAVAN AI assistant in English or Tamil. Browser speech input/output depends on browser support.
7. For offline use, the app shell is cached and farmer-entered readings are queued locally until connectivity returns. Weather and generative AI require internet.

## Optional configuration

- `OPENAI_API_KEY`: add your own key to `.env` to enable generative AI. Never put the key in frontend code or commit `.env`.
- `FIELD_LAT` and `FIELD_LON`: coordinates used by the real Open-Meteo weather forecast. Defaults are example coordinates; set them to your field.
- `JWT_SECRET`: use a long random secret.

## The eight feature areas

1. AI + user-provided farm/soil inputs (not hardware sensor integration).
2. Water waste/leak alerts based on entered pump state and flow rate.
3. Crop-based irrigation rules.
4. Tamil/English browser voice assistant.
5. Weather-aware recommendations that combine entered rain probability with Open-Meteo live forecast when available; falls back to the entered value if weather is unreachable.
6. Water-use dashboard, readings history and moisture trend.
7. Low-water warning and pump-start recommendation blocking in the rule engine; it does not physically control a pump.
8. Cached app shell and offline queue for manually entered readings.

## Important limitations

- This is a web-only monitoring and decision-support app. Pump ON/OFF is a status the farmer enters, not a physical pump control.
- Leak detection depends on accurate values entered by the user; it cannot sense a real leak independently.
- Crop moisture thresholds are starting guidance and should be calibrated for crop stage, soil type and local agricultural advice.
- Water use is estimated from the flow rate while the entered pump status is ON, assuming a five-second reporting interval in the current backend. For manual entries, treat it as an approximate estimate, not a meter reading.
- The JSON file database is intended for a single-process local deployment. For public production hosting, use persistent storage, HTTPS, backups, monitoring and a managed database.


## Main workflow: analyze your own inputs

Sign in, then use the **Enter farm details** form on the dashboard. Enter crop, field area, soil moisture, temperature, humidity, rain probability, available water, minimum reserve, irrigation duration, flow rate and observed pump status. Click **Analyze my farm inputs**. The `/api/farm/analyze` endpoint returns irrigation advice, estimated water use and remaining water, risk alerts, weather impact, and an optional AI explanation. Both plan buttons use this manual-input workflow; no device reading is needed. The assistant can also use the latest submitted manual analysis as context.

Feature scope for this web-only workflow:
1. AI assistant and analysis of manually entered farm/soil data (OpenAI key is optional for generative answers).
2. Leak/waste risk flags based on entered pump state and flow rate.
3. Crop-aware rule-based irrigation suggestions.
4. Tamil/English typed and browser voice assistant.
5. Weather-aware guidance using user-entered rain probability plus a separate real weather forecast panel.
6. Water balance, estimates, chart and saved input/readings dashboard.
7. Low-water threshold warning and irrigation recommendation blocking; no physical pump shutdown.
8. Cached app shell and locally queued entries when offline; weather and generative AI need connectivity.

All calculations are decision-support estimates. The website cannot independently verify manual inputs, sense a physical leak, or physically control irrigation hardware.
