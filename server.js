const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

// =============================================
// KONFIGURASI — GANTI BAGIAN INI
// =============================================
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const THINGSBOARD_TOKEN = process.env.TB_TOKEN ;
// =============================================

const GEMINI_URL       = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + GEMINI_API_KEY;
const THINGSBOARD_URL  = "https://thingsboard.cloud/api/v1/" + THINGSBOARD_TOKEN + "/telemetry";

// Kirim data ke ThingsBoard
async function sendToThingsBoard(payload) {
  try {
    await axios.post(THINGSBOARD_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 5000
    });
    console.log("[ThingsBoard] Terkirim: " + JSON.stringify(payload));
  } catch (err) {
    console.error("[ThingsBoard] Gagal: " + err.message);
  }
}

// Analisis posisi tubuh dengan Gemini AI
async function analyzeWithGemini(data) {
  var prompt = "Kamu adalah sistem AI deteksi posisi tubuh manusia dari sensor MPU6050. ";
  prompt += "Klasifikasi posisi: ";
  prompt += "NORMAL (pitch -10 sampai 10 derajat, roll -15 sampai 15 derajat), ";
  prompt += "MIRING (roll antara 15 sampai 45 derajat), ";
  prompt += "JATUH (pitch atau roll lebih dari 45 derajat kombinasi ekstrim), ";
  prompt += "BERBARING (pitch lebih dari 60 atau kurang dari -60 derajat), ";
  prompt += "WASPADA (nilai sangat ekstrim kemungkinan darurat). ";
  prompt += "Balas HANYA dalam format JSON berikut tanpa tambahan apapun: ";
  prompt += "{\"status\":\"NORMAL\",\"confidence\":90,\"pesan\":\"kalimat singkat max 20 kata\",\"lcd_line1\":\"max 16 karakter\",\"lcd_line2\":\"max 16 karakter\",\"alert\":false}. ";
  prompt += "Data sensor sekarang: Pitch=" + data.pitch + " derajat, Roll=" + data.roll + " derajat, Latitude=" + data.latitude + ", Longitude=" + data.longitude + ".";

  var body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 300
    }
  };

  var resp = await axios.post(GEMINI_URL, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 15000
  });

  var rawText = resp.data.candidates[0].content.parts[0].text;
  var clean = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(clean);
}

// Analisis cadangan jika Gemini tidak merespons
function fallbackAnalysis(pitch, roll) {
  var ap = Math.abs(pitch);
  var ar = Math.abs(roll);

  if (ap > 60 || ar > 60) {
    return {
      status: "JATUH",
      confidence: 85,
      pesan: "Kemungkinan pengguna jatuh! Segera periksa kondisi.",
      lcd_line1: "STATUS: JATUH!",
      lcd_line2: "Harap periksa!",
      alert: true
    };
  }
  if (ap > 45 || ar > 45) {
    return {
      status: "WASPADA",
      confidence: 75,
      pesan: "Posisi tubuh sangat ekstrim, perlu perhatian segera.",
      lcd_line1: "STATUS: WASPADA",
      lcd_line2: "Posisi ekstrim",
      alert: true
    };
  }
  if (ar > 15) {
    return {
      status: "MIRING",
      confidence: 80,
      pesan: "Tubuh miring, perhatikan postur tubuh Anda.",
      lcd_line1: "STATUS: MIRING",
      lcd_line2: "Tubuh miring",
      alert: false
    };
  }
  return {
    status: "NORMAL",
    confidence: 90,
    pesan: "Posisi tubuh normal dan baik.",
    lcd_line1: "STATUS: NORMAL",
    lcd_line2: "Posisi baik",
    alert: false
  };
}

// Endpoint utama - terima data dari ESP32
app.post("/analyze", async function(req, res) {
  var latitude   = req.body.latitude   || 0;
  var longitude  = req.body.longitude  || 0;
  var pitch      = req.body.pitch;
  var roll       = req.body.roll;
  var gyroEnabled = req.body.gyroEnabled;

  if (pitch === undefined || roll === undefined) {
    return res.status(400).json({ error: "pitch dan roll wajib diisi" });
  }

  console.log("================================");
  console.log("[DATA MASUK]");
  console.log("Pitch      : " + pitch);
  console.log("Roll       : " + roll);
  console.log("Latitude   : " + latitude);
  console.log("Longitude  : " + longitude);
  console.log("Gyro aktif : " + (gyroEnabled ? "Ya" : "Tidak"));

  try {
    // Kirim ke Gemini AI
    var result = await analyzeWithGemini({ pitch: pitch, roll: roll, latitude: latitude, longitude: longitude });

    console.log("[HASIL AI]");
    console.log("Status     : " + result.status);
    console.log("Confidence : " + result.confidence + "%");
    console.log("Pesan      : " + result.pesan);
    console.log("Alert      : " + (result.alert ? "YA" : "Tidak"));
    console.log("================================");

    // Kirim ke ThingsBoard
    sendToThingsBoard({
      pitch:          pitch,
      roll:           roll,
      latitude:       latitude,
      longitude:      longitude,
      gyroEnabled:    gyroEnabled ? 1 : 0,
      ai_status:      result.status,
      ai_confidence:  result.confidence,
      ai_alert:       result.alert ? 1 : 0,
      ai_pesan:       result.pesan
    });

    return res.json(result);

  } catch (err) {
    console.error("[ERROR Gemini] " + err.message);
    console.log("[Menggunakan analisis cadangan]");

    var fb = fallbackAnalysis(pitch, roll);

    console.log("[HASIL CADANGAN]");
    console.log("Status : " + fb.status);
    console.log("================================");

    sendToThingsBoard({
  pitch:          pitch,
  roll:           roll,
  latitude:       latitude,
  longitude:      longitude,
  gyroEnabled:    gyroEnabled ? 1 : 0,
  ai_status:      fb.status,
  ai_confidence:  fb.confidence,
  ai_alert:       fb.alert ? 1 : 0,
  ai_pesan:       fb.pesan,
  ai_error:       1
});

    return res.json(fb);
  }
});

// Endpoint cek status server
app.get("/status", function(req, res) {
  res.json({
    status: "aktif",
    uptime_detik: Math.floor(process.uptime()),
    waktu: new Date().toLocaleString("id-ID")
  });
});

// Jalankan server
app.listen(3000,'0.0.0.0', function() {
  console.log("================================");
  console.log("  Posture AI Server AKTIF");
  console.log("  Port    : 3000");
  console.log("  Endpoint: POST /analyze");
  console.log("  Cek     : GET  /status");
  console.log("================================");
});
