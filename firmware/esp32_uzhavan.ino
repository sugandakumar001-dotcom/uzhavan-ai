// OPTIONAL HARDWARE INTEGRATION ONLY.
// The UZHAVAN AI website works without ESP32 or sensors.
/*
  UZHAVAN AI ESP32 telemetry starter (Arduino IDE)
  Required libraries: WiFi, HTTPClient, ArduinoJson.
  IMPORTANT:
  - This sketch sends telemetry only; it does NOT operate a pump/relay.
  - Verify sensor models, ADC ranges, voltage levels and calibration before use.
  - Never rely on web software alone for dry-run/low-water/overcurrent/emergency stop protection.
  - Backend endpoint: https://YOUR_HOST/api/device/readings
*/
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* API_URL = "https://YOUR_HOST/api/device/readings";
const char* DEVICE_API_KEY = "REPLACE_WITH_DEVICE_API_KEY";

// Example pins only. Adapt for your exact sensors and ESP32 board.
const int SOIL_PIN = 34;     // analog soil sensor output
const int TANK_PIN = 35;     // optional analog tank level sensor
const int FLOW_PIN = 27;     // pulse output from a compatible flow meter
const int DHT_PLACEHOLDER = -1; // add DHT library + correct model if used

volatile uint32_t flowPulses = 0;
unsigned long lastSend = 0;
float flowCalibrationPulsesPerLitre = 450.0; // MUST calibrate for your meter
int soilDryRaw = 3200; // calibrate in your soil, dry reference
int soilWetRaw = 1400; // calibrate in your soil, wet reference
int tankEmptyRaw = 3000; // calibrate for your tank sensor
int tankFullRaw = 1200;  // calibrate for your tank sensor
// Set true only after implementing and validating an independent hardware safety circuit.
const bool HARDWARE_INTERLOCKS_VALIDATED = false;
bool pumpRunningFeedback = false; // replace with actual isolated feedback input if available

void IRAM_ATTR onFlowPulse() { flowPulses++; }

int toPercent(int raw, int low, int high) {
  if (low == high) return 0;
  long pct = (long)(raw - low) * 100L / (high - low);
  return constrain((int)pct, 0, 100);
}
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) delay(300);
}
void setup() {
  Serial.begin(115200);
  pinMode(FLOW_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), onFlowPulse, RISING);
  analogReadResolution(12);
  connectWiFi();
}
void loop() {
  if (millis() - lastSend < 5000) { delay(50); return; }
  lastSend = millis();
  connectWiFi();

  int soilRaw = analogRead(SOIL_PIN);
  int tankRaw = analogRead(TANK_PIN);
  int soilPct = toPercent(soilRaw, soilDryRaw, soilWetRaw);
  int tankPct = toPercent(tankRaw, tankEmptyRaw, tankFullRaw);

  noInterrupts(); uint32_t pulses = flowPulses; flowPulses = 0; interrupts();
  // For a 5-second interval, L/min = litres in interval * 12.
  float litresInInterval = pulses / flowCalibrationPulsesPerLitre;
  float flowLpm = litresInInterval * 12.0;

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(API_URL);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-device-key", DEVICE_API_KEY);
    StaticJsonDocument<256> doc;
    doc["soilMoisture"] = soilPct;
    doc["temperatureC"] = 0;       // replace with actual temperature sensor reading
    doc["humidityPercent"] = 0;     // replace with actual humidity sensor reading
    doc["tankPercent"] = tankPct;
    doc["flowRateLpm"] = flowLpm;
    doc["pumpRunning"] = pumpRunningFeedback;
    String body; serializeJson(doc, body);
    int status = http.POST(body);
    Serial.printf("Telemetry HTTP status: %d\n", status);
    http.end();
  } else {
    Serial.printf("Offline: soil=%d%% tank=%d%% flow=%.2f L/min\n", soilPct, tankPct, flowLpm);
  }
}
