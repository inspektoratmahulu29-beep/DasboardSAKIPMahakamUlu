import { getMasterData } from './sakipMasterData.js';

// ============ HELPER KEAMANAN ============
function sanitizeString(str, maxLength = 200) {
  if (!str) return "";
  return String(str)
    .replace(/[<>"'`\\]/g, '')      // buang karakter berbahaya
    .replace(/[\/:*?"<>|#%{}]/g, ' ') // buang karakter path ilegal
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLength);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone) {
  return /^[0-9+\-() ]{8,20}$/.test(phone);
}

// Rate limiting sederhana dengan D1
async function checkRateLimit(env, ip, action, limit = 5, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT COUNT(*) as cnt, MAX(timestamp) as last FROM rate_limits WHERE ip = ? AND action = ? AND timestamp > ?"
  ).bind(ip, action, now - windowMs).all();
  if (results[0].cnt >= limit) {
    throw new Error("Terlalu banyak percobaan. Silakan coba lagi nanti.");
  }
  await env.DB.prepare(
    "INSERT INTO rate_limits (ip, action, timestamp) VALUES (?, ?, ?)"
  ).bind(ip, action, now).run();
}

// CORS aman
function jsonResponse(data, status = 200, requestOrigin = null) {
  const allowedOrigins = (typeof process !== 'undefined' && process.env.ALLOWED_ORIGIN) ? process.env.ALLOWED_ORIGIN.split(',') : [];
  let origin = '*';
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    origin = requestOrigin;
  } else if (requestOrigin && allowedOrigins.length === 0) {
    // Jika tidak diset, izinkan origin yang sama (untuk production, sebaiknya diset)
    origin = requestOrigin;
  }
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// Normalisasi teks (fungsi asli tetap dipertahankan)
function normalizeText(str) {
  if (!str) return "";
  let result = str.toLowerCase();
  const acronyms = ["dpa", "opd", "sakip", "pm", "insp", "iku", "lkjip", "apip", "renstra", "dprd", "ta", "lhe", "akip"];
  acronyms.forEach(ac => {
    result = result.replace(new RegExp(`\\b${ac}\\b`, "g"), ac.toUpperCase());
  });
  result = result.replace(/(^\s*\w|[\.\!\?]\s*\w)/g, c => c.toUpperCase());
  return result;
}

function cleanNote(note) {
  if (!note) return "";
  return note.replace(/\s+/g, ' ').trim();
}

function formatNoteToRecommendation(noteItem) {
  const { id, kriteria, note } = noteItem;
  const cleanedNote = cleanNote(note);
  if (!cleanedNote) return "";
  return `Perbaiki kriteria ${id} (${kriteria}). ${cleanedNote.charAt(0).toUpperCase() + cleanedNote.slice(1)}`;
}

// ============ GOOGLE DRIVE INTEGRATION ============
async function getGoogleAccessToken(env) {
  const { GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN } = env;
  if (!GOOGLE_DRIVE_CLIENT_ID || !GOOGLE_DRIVE_CLIENT_SECRET || !GOOGLE_DRIVE_REFRESH_TOKEN) throw new Error('Google Drive credentials not configured');
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: GOOGLE_DRIVE_CLIENT_ID, client_secret: GOOGLE_DRIVE_CLIENT_SECRET, refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) throw new Error('Failed to get Google Drive access token: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}
async function createFolder(accessToken, parentId, folderName) {
  const response = await fetch('https://www.googleapis.com/drive/v3/files', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }) });
  const data = await response.json(); if (!response.ok) throw new Error('Gagal membuat folder: ' + JSON.stringify(data)); return data.id;
}
async function getOrCreateFolder(accessToken, parentId, folderName) {
  const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json(); if (data.files && data.files.length > 0) return data.files[0].id; return await createFolder(accessToken, parentId, folderName);
}
async function uploadToGoogleDrive(env, filePath, fileName, bytes, rootFolderId) {
  const accessToken = await getGoogleAccessToken(env); const pathSegments = filePath.split('/'); pathSegments.pop(); let currentFolderId = rootFolderId;
  for (const folderName of pathSegments) { if (!folderName) continue; currentFolderId = await getOrCreateFolder(accessToken, currentFolderId, folderName); }
  const metadata = { name: fileName, parents: [currentFolderId] };
  const initResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': bytes.length.toString() }, body: JSON.stringify(metadata) });
  if (!initResponse.ok) throw new Error('Gagal inisialisasi upload: ' + await initResponse.text());
  const location = initResponse.headers.get('Location'); if (!location) throw new Error('Tidak ada URL upload dari Google Drive');
  const uploadResponse = await fetch(location, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length.toString() }, body: bytes });
  const result = await uploadResponse.json(); if (!uploadResponse.ok) throw new Error('Gagal upload file ke Google Drive: ' + JSON.stringify(result)); return result.id;
}
async function createGoogleDoc(env, htmlContent, fileName, rootFolderId) {
  const accessToken = await getGoogleAccessToken(env);
  const createResponse = await fetch('https://www.googleapis.com/drive/v3/files', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: fileName, mimeType: 'application/vnd.google-apps.document', parents: [rootFolderId] }) });
  const fileData = await createResponse.json(); if (!createResponse.ok) throw new Error('Gagal membuat Google Docs: ' + JSON.stringify(fileData));
  const fileId = fileData.id;
  const updateResponse = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, { method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/html' }, body: htmlContent });
  if (!updateResponse.ok) throw new Error('Gagal memasukkan konten ke Google Docs: ' + await updateResponse.text());
  return `https://docs.google.com/document/d/${fileId}/edit`;
}
async function deleteGoogleDriveFile(env, fileId) {
  const accessToken = await getGoogleAccessToken(env); const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok && response.status !== 404) throw new Error('Gagal hapus file di Google Drive: ' + await response.text());
}

// ============ HELPER FUNCTIONS (SESUAI ASLI) ============
async function getBulkData(year, env) {
  const [opds, scores, evidence, qa] = await Promise.all([
    env.DB.prepare("SELECT opd_name FROM opds WHERE year = ? ORDER BY opd_name").bind(year).all(),
    env.DB.prepare("SELECT opd_name, criteria_id, pm_grade, pm_note, insp_grade, insp_note FROM data_scores WHERE year = ?").bind(year).all(),
    env.DB.prepare("SELECT opd_name, criteria_id, url, gdrive_id, file_name, upload_date FROM evidence WHERE year = ?").bind(year).all(),
    env.DB.prepare("SELECT opd_name, status FROM qa_status WHERE year = ?").bind(year).all()
  ]);

  const scoreMap = {};
  scores.results.forEach(row => {
    if (!scoreMap[row.opd_name]) scoreMap[row.opd_name] = {};
    scoreMap[row.opd_name][row.criteria_id] = row;
  });

  const evMap = {};
  evidence.results.forEach(row => {
    if (!evMap[row.opd_name]) evMap[row.opd_name] = {};
    if (!evMap[row.opd_name][row.criteria_id]) evMap[row.opd_name][row.criteria_id] = [];
    evMap[row.opd_name][row.criteria_id].push({ url: row.url, fileName: row.file_name, date: row.upload_date });
  });

  const qaMap = {};
  qa.results.forEach(row => { qaMap[row.opd_name] = row.status; });

  const master = getMasterData();
  master.forEach(row => { if (!row.RuleMap) row.RuleMap = {}; });

  return opds.results.map(opd => {
    const fullData = master.map(row => {
      const sc = (scoreMap[opd.opd_name] || {})[row.ID] || {};
      return { ...row, pmGrade: sc.pm_grade || "", pmNote: sc.pm_note || "", inspGrade: sc.insp_grade || "", inspNote: sc.insp_note || "", evUrls: (evMap[opd.opd_name] || {})[row.ID] || [], qaApipStatus: qaMap[opd.opd_name] || 'Belum' };
    });
    
    let pmTotal = 0, inspTotal = 0;
    fullData.forEach(row => {
      pmTotal += row.RuleMap[row.pmGrade] || 0;
      inspTotal += row.RuleMap[row.inspGrade] || 0;
    });
    const totalBobot = fullData.reduce((sum, row) => sum + (row.Bobot || 0), 0);
    
    return {
      opd_name: opd.opd_name,
      data: fullData,
      pmTotal: pmTotal.toFixed(2),
      inspTotal: inspTotal.toFixed(2),
      progress: totalBobot > 0 ? ((pmTotal / totalBobot) * 100).toFixed(0) + '%' : '0%',
      qaApipStatus: qaMap[opd.opd_name] || 'Belum'
    };
  });
}

async function getPMDataForInspectorData(year, opdName, env, bulkData = null) {
  if (bulkData) {
    const o = bulkData.find(x => x.opd_name === opdName);
    if (o) return o.data;
  }
  const master = getMasterData();
  const dataScores = await env.DB.prepare("SELECT * FROM data_scores WHERE year = ? AND opd_name = ?").bind(year, opdName).all();
  const scoreMap = {}; dataScores.results.forEach(row => { scoreMap[row.criteria_id] = row; });
  const qaRow = await env.DB.prepare("SELECT status FROM qa_status WHERE year = ? AND opd_name = ?").bind(year, opdName).first();
  const qaStatus = qaRow ? qaRow.status : 'Belum';
  const evidenceRows = await env.DB.prepare("SELECT * FROM evidence WHERE year = ? AND opd_name = ?").bind(year, opdName).all();
  const evMap = {}; evidenceRows.results.forEach(row => { if (!evMap[row.criteria_id]) evMap[row.criteria_id] = []; evMap[row.criteria_id].push({ url: row.url, fileName: row.file_name, date: row.upload_date }); });

  return master.map(row => {
    const sc = scoreMap[row.ID] || {};
    return { ...row, pmGrade: sc.pm_grade || "", pmNote: sc.pm_note || "", inspGrade: sc.insp_grade || "", inspNote: sc.insp_note || "", evUrls: evMap[row.ID] || [], qaApipStatus: qaStatus };
  });
}

async function getPrevScores(year, opdName, env) { const { results } = await env.DB.prepare("SELECT komponen, nilai FROM prev_scores WHERE year = ? AND opd_name = ?").bind(year, opdName).all(); const map = {}; results.forEach(r => { map[r.komponen] = parseFloat(r.nilai) || 0; }); return map; }
async function savePrevScores(year, opdName, scores, env) { for (const [komponen, nilai] of Object.entries(scores)) { await env.DB.prepare(`INSERT INTO prev_scores (year, opd_name, komponen, nilai) VALUES (?, ?, ?, ?) ON CONFLICT(year, opd_name, komponen) DO UPDATE SET nilai = excluded.nilai`).bind(year, opdName, komponen, parseFloat(nilai) || 0).run(); } return true; }

function getPredikat(totalNilai) { if (totalNilai >= 90) return "A"; if (totalNilai >= 80) return "BB"; if (totalNilai >= 70) return "B"; if (totalNilai >= 60) return "CC"; if (totalNilai >= 50) return "C"; if (totalNilai >= 30) return "D"; return "E"; }

function getKriteriaStatus(data, source) {
  const hasil = {};
  const komponenList = ["PERENCANAAN KINERJA", "PENGUKURAN KINERJA", "PELAPORAN KINERJA", "EVALUASI AKUNTABILITAS KINERJA INTERNAL"];
  komponenList.forEach(k => { hasil[k] = { terpenuhi: [], belum: [], catatan: [] }; });
  
  data.forEach(row => {
    const komp = row.Komponen;
    const grade = source === 'pm' ? row.pmGrade : row.inspGrade;
    const note = source === 'pm' ? row.pmNote : row.inspNote;
    if (note && note.trim() !== "") {
      hasil[komp].catatan.push({ id: row.ID, kriteria: normalizeText(row.Kriteria), note: cleanNote(note) });
    }
    if (grade === "A" || grade === "B") {
      hasil[komp].terpenuhi.push(row.ID + " - " + normalizeText(row.Kriteria));
    } else {
      hasil[komp].belum.push(row.ID + " - " + normalizeText(row.Kriteria));
    }
  });
  return hasil;
}

function buildRekomendasiRingkas(maxBobot, nilaiKomponen, data, source, catatanList) {
  const rekomendasi = [];
  const komponenList = ["PERENCANAAN KINERJA", "PENGUKURAN KINERJA", "PELAPORAN KINERJA", "EVALUASI AKUNTABILITAS KINERJA INTERNAL"];
  komponenList.forEach(k => {
    if (maxBobot[k] > 0 && (nilaiKomponen[k] / maxBobot[k]) < 0.7) {
      if (k === "PERENCANAAN KINERJA") {
        rekomendasi.push("Melakukan reviu dan penyempurnaan Pohon Kinerja serta cascading agar hubungan sebab-akibat antarindikator terlihat jelas.");
        rekomendasi.push("Menetapkan dan memperbaiki indikator kinerja utama berbasis outcome yang memenuhi prinsip SMART.");
        rekomendasi.push("Menyusun Manual Indikator/Profil Indikator untuk seluruh IKU.");
      } else if (k === "PENGUKURAN KINERJA") {
        rekomendasi.push("Melaksanakan pengukuran serta rapat evaluasi kinerja secara berkala, sekurang-kurangnya setiap triwulan.");
        rekomendasi.push("Menyelaraskan Rencana Aksi dengan postur DPA/DPA Perubahan.");
      } else if (k === "PELAPORAN KINERJA") {
        rekomendasi.push("Melengkapi LKjIP dengan reviu internal yang resmi dan berjenjang.");
      } else if (k === "EVALUASI AKUNTABILITAS KINERJA INTERNAL") {
        rekomendasi.push("Membentuk secara resmi Tim Evaluator Mandiri melalui Surat Tugas.");
        rekomendasi.push("Menyusun tindak lanjut hasil evaluasi dalam bentuk laporan naratif.");
      }
    }
  });

  if (catatanList) {
    catatanList.forEach(item => {
      const formatted = formatNoteToRecommendation(item);
      if (formatted) rekomendasi.push(formatted);
    });
  }
  return [...new Set(rekomendasi)];
}

async function generateRekomendasiWithAI(env, kriteriaBelum, maxBobot, nilaiKomponen, data, source = 'pm') {
  const daftarKriteria = [];
  Object.keys(kriteriaBelum).forEach(komp => {
    if (kriteriaBelum[komp] && kriteriaBelum[komp].belum) daftarKriteria.push(...kriteriaBelum[komp].belum);
  });

  const catatan = [];
  if (data) data.forEach(row => {
    if (source === 'pm' && row.pmNote && row.pmNote.trim() !== "") catatan.push(`[Kriteria ${row.ID}] ${normalizeText(row.Kriteria)}: ${cleanNote(row.pmNote)}`);
    if (source === 'insp' && row.inspNote && row.inspNote.trim() !== "") catatan.push(`[Kriteria ${row.ID}] ${normalizeText(row.Kriteria)}: ${cleanNote(row.inspNote)}`);
  });

  let prompt = `Anda adalah auditor ahli SAKIP. Berikan 5-8 rekomendasi perbaikan yang spesifik dan actionable untuk SAKIP berdasarkan kriteria yang belum terpenuhi berikut:\n${daftarKriteria.join('\n')}\n\n`;
  if (catatan.length > 0) {
    prompt += `\nBerikut adalah catatan dari ${source === 'pm' ? 'Penilai Mandiri (PM/OPD)' : 'Inspektorat (APIP)'} yang perlu diubah menjadi rekomendasi perbaikan yang profesional:\n${catatan.join('\n')}\n\n`;
    prompt += `TUGAS PENTING: Ubahlah setiap catatan mentah tersebut menjadi kalimat rekomendasi perbaikan yang profesional dan mudah dipahami. JANGAN gunakan label "Catatan PM:" atau "Catatan Inspektorat:" di output. Gunakan huruf kecil/kapital sesuai kaidah Bahasa Indonesia (EYD), JANGAN menggunakan huruf kapital berlebihan (ALL CAPS). Gabungkan dengan rekomendasi umum Anda.\n\n`;
  }
  prompt += `\nKeluarkan sebagai daftar poin (bullet). Jangan terlalu panjang.`;

  const isValidList = (list) => {
    if (!list || list.length === 0) return false;
    return list.every(item => item && item.length > 5 && /[a-zA-Z]/.test(item) && !/^["'`]/.test(item));
  };

  if (env.AI) {
    const models = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];
    for (const model of models) {
      try {
        const response = await env.AI.run(model, { messages: [{ role: 'user', content: prompt }] });
        if (response && response.response) {
          const list = response.response.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(l => l.length > 0);
          if (isValidList(list)) return { list, provider: `Workers AI (${model})` };
        }
      } catch (e) { console.error(`Workers AI (${model}) gagal:`, e.message); }
    }
  }

  if (env.AI_API_KEY) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.AI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
      if (response.ok) {
        const data = await response.json();
        const text = data.candidates[0].content.parts[0].text || '';
        const list = text.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(l => l.length > 0);
        if (isValidList(list)) return { list, provider: "Google Gemini" };
      } else { console.error('Gemini HTTP Error:', response.status, await response.text()); }
    } catch (e) { console.error('Gemini gagal:', e.message); }
  }

  if (env.MISTRAL_API_KEY) {
    try {
      const response = await fetch('https://api.mistral.ai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${env.MISTRAL_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }] }) });
      if (response.ok) {
        const data = await response.json();
        const text = data.choices[0].message.content || '';
        const list = text.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(l => l.length > 0);
        if (isValidList(list)) return { list, provider: "Mistral AI" };
      } else { console.error('Mistral HTTP Error:', response.status, await response.text()); }
    } catch (e) { console.error('Mistral AI gagal:', e.message); }
  }

  if (env.GROQ_API_KEY) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'llama3-8b-8192', messages: [{ role: 'user', content: prompt }] }) });
      if (response.ok) {
        const data = await response.json();
        const text = data.choices[0].message.content || '';
        const list = text.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(l => l.length > 0);
        if (isValidList(list)) return { list, provider: "Groq" };
      } else { console.error('Groq HTTP Error:', response.status, await response.text()); }
    } catch (e) { console.error('Groq gagal:', e.message); }
  }

  console.warn('Semua AI Gagal. Menggunakan Fallback Template.');
  const catatanList = [];
  Object.keys(kriteriaBelum).forEach(komp => {
    if (kriteriaBelum[komp] && kriteriaBelum[komp].catatan) catatanList.push(...kriteriaBelum[komp].catatan);
  });
  return { list: buildRekomendasiRingkas(maxBobot, nilaiKomponen, data, source, catatanList), provider: "Template" };
}

async function generateClosingWithAI(env, data, totalNilai, predikat, opdName, year, source) {
  const komponenList = ["PERENCANAAN KINERJA", "PENGUKURAN KINERJA", "PELAPORAN KINERJA", "EVALUASI AKUNTABILITAS KINERJA INTERNAL"];
  const maxBobot = { "PERENCANAAN KINERJA": 0, "PENGUKURAN KINERJA": 0, "PELAPORAN KINERJA": 0, "EVALUASI AKUNTABILITAS KINERJA INTERNAL": 0 };
  const nilaiKomponen = { "PERENCANAAN KINERJA": 0, "PENGUKURAN KINERJA": 0, "PELAPORAN KINERJA": 0, "EVALUASI AKUNTABILITAS KINERJA INTERNAL": 0 };
  const gradeField = source === 'pm' ? 'pmGrade' : 'inspGrade';

  data.forEach(row => { if (!row.RuleMap) row.RuleMap = {}; const komp = row.Komponen; const bobot = row.Bobot || 0; const nilai = row.RuleMap[row[gradeField]] || 0; maxBobot[komp] += bobot; nilaiKomponen[komp] += nilai; });

  let totalMax = komponenList.reduce((sum, k) => sum + maxBobot[k], 0);
  let weakestComp = komponenList[0], highestComp = komponenList[0]; let minPct = 999, maxPct = -1;

  komponenList.forEach(k => {
    const pct = totalMax > 0 ? (nilaiKomponen[k] / totalMax * 100) : 0;
    if (pct < minPct) { minPct = pct; weakestComp = k; }
    if (pct > maxPct) { maxPct = pct; highestComp = k; }
  });

  let prompt = `Tuliskan paragraf penutup yang sangat deskriptif, analitis, dan profesional untuk Laporan Hasil Evaluasi ${source === 'pm' ? 'Penilaian Mandiri (LHE PM)' : 'Penilaian Inspektorat (LHE INSP)'} Akuntabilitas Kinerja Instansi Pemerintah (AKIP) untuk ${opdName} Kabupaten Mahakam Ulu Tahun Anggaran ${year}. Total nilai akhir adalah ${totalNilai.toFixed(2)} dengan predikat ${predikat}. Komponen terkuat adalah ${highestComp} dengan kontribusi nilai sebesar ${maxPct.toFixed(2)} poin dari total 100. Komponen terlemah adalah ${weakestComp} dengan kontribusi nilai sebesar ${minPct.toFixed(2)} poin dari total 100. Lakukan analisis mendalam mengenai kekuatan, kelemahan, hambatan, dan langkah strategis yang harus diambil oleh ${opdName} ke depannya. Gunakan bahasa Indonesia yang baku, mengalir, dan formal. PASTIKAN huruf besar dan kecil ditulis sesuai kaidah EYD (JANGAN menggunakan huruf kapital berlebihan pada kata biasa). Panjang paragraf sekitar 150-200 kata.`;

  if (env.AI) {
    const models = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];
    for (const model of models) {
      try { const response = await env.AI.run(model, { messages: [{ role: 'user', content: prompt }] }); if (response && response.response) return { text: response.response.trim(), provider: `Workers AI (${model})` }; } catch (e) { console.error(`Closing Workers AI (${model}) gagal:`, e.message); }
    }
  }

  if (env.AI_API_KEY) { try { const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.AI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }); if (response.ok) { const data = await response.json(); const text = data.candidates[0].content.parts[0].text || ''; if (text.trim().length > 0) return { text: text.trim(), provider: "Google Gemini" }; } } catch (e) { console.error('Closing Gemini gagal:', e.message); } }
  if (env.MISTRAL_API_KEY) { try { const response = await fetch('https://api.mistral.ai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${env.MISTRAL_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }] }) }); if (response.ok) { const data = await response.json(); const text = data.choices[0].message.content || ''; if (text.trim().length > 0) return { text: text.trim(), provider: "Mistral AI" }; } } catch (e) { console.error('Closing Mistral gagal:', e.message); } }
  if (env.GROQ_API_KEY) { try { const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'llama3-8b-8192', messages: [{ role: 'user', content: prompt }] }) }); if (response.ok) { const data = await response.json(); const text = data.choices[0].message.content || ''; if (text.trim().length > 0) return { text: text.trim(), provider: "Groq" }; } } catch (e) { console.error('Closing Groq gagal:', e.message); } }

  let fallbackText = `Secara keseluruhan, capaian akuntabilitas kinerja ${opdName} pada Tahun Anggaran ${year} menunjukkan hasil ${totalNilai.toFixed(2)} dengan predikat ${predikat}. Berdasarkan analisis, komponen ${highestComp} telah menunjukkan kontribusi yang paling besar, yaitu sebesar ${maxPct.toFixed(2)} poin dari total 100, menunjukkan bahwa proses pengukuran dan pelaporan sudah berjalan cukup baik. Sebaliknya, komponen ${weakestComp} menjadi titik lemah karena hanya memberikan kontribusi sebesar ${minPct.toFixed(2)} poin, yang mengindikasikan adanya hambatan pada proses perencanaan dan penguatan internal. Hambatan utama umumnya terletak pada ketidakkonsistenan dokumen dan belum optimalnya pemanfaatan data kinerja. Kami merekomendasikan agar ${opdName} segera menindaklanjuti seluruh catatan strategis yang telah diberikan, memperkuat kapasitas SDM, dan terus melakukan pembenahan berkelanjutan untuk mewujudkan tata kelola pemerintahan yang berorientasi pada hasil dan berdampak nyata bagi masyarakat.`;

  return { text: fallbackText, provider: "Template Dinamis" };
}

// ============ FUNGSI UNTUK MEMBUAT HTML LAPORAN ============
async function generateLaporanHtml({ year, opdName, env, source }) {
  const data = await getPMDataForInspectorData(year, opdName, env);
  const komponenList = ["PERENCANAAN KINERJA", "PENGUKURAN KINERJA", "PELAPORAN KINERJA", "EVALUASI AKUNTABILITAS KINERJA INTERNAL"];
  const maxBobot = { "PERENCANAAN KINERJA": 0, "PENGUKURAN KINERJA": 0, "PELAPORAN KINERJA": 0, "EVALUASI AKUNTABILITAS KINERJA INTERNAL": 0 };
  const nilaiKomponen = { "PERENCANAAN KINERJA": 0, "PENGUKURAN KINERJA": 0, "PELAPORAN KINERJA": 0, "EVALUASI AKUNTABILITAS KINERJA INTERNAL": 0 };

  const formattedOpdName = opdName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

  const groupedData = {};

  data.forEach(row => {
    if (!row.RuleMap) row.RuleMap = {};
    if (!groupedData[row.Komponen]) groupedData[row.Komponen] = { totalBobot: 0, totalNilai: 0, subKomponen: {} };
    if (!groupedData[row.Komponen].subKomponen[row.SubKomponen]) groupedData[row.Komponen].subKomponen[row.SubKomponen] = { totalBobot: 0, totalNilai: 0, kriteria: [] };

    const nilai = row.RuleMap[source === 'pm' ? row.pmGrade : row.inspGrade] || 0;

    groupedData[row.Komponen].totalBobot += row.Bobot;
    groupedData[row.Komponen].totalNilai += nilai;
    groupedData[row.Komponen].subKomponen[row.SubKomponen].totalBobot += row.Bobot;
    groupedData[row.Komponen].subKomponen[row.SubKomponen].totalNilai += nilai;
    groupedData[row.Komponen].subKomponen[row.SubKomponen].kriteria.push(row);
  });

  let totalNilai = 0, totalMax = 0; komponenList.forEach(k => {
    if (groupedData[k]) {
        totalNilai += groupedData[k].totalNilai;
        totalMax += groupedData[k].totalBobot;
    }
  });
  const predikat = getPredikat(totalNilai);
  const prevScores = await getPrevScores(year, opdName, env);
  const statusKriteria = getKriteriaStatus(data, source);

  const aiResult = await generateRekomendasiWithAI(env, statusKriteria, maxBobot, nilaiKomponen, data, source);
  const aiClosing = await generateClosingWithAI(env, data, totalNilai, predikat, formattedOpdName, year, source);
  const rekomendasi = aiResult.list;
  const aiProvider = aiResult.provider;
  const closingParagraph = aiClosing.text;

  let html = `<html><head><title>LHE ${source === 'pm' ? 'PM' : 'INSP'} SAKIP ${formattedOpdName} TA ${year}</title></head>`;
  html += `<body style="font-family: 'Times New Roman', Times, serif; font-size: 12pt; line-height: 1.5; margin: 2cm; text-align: justify;">`;

  html += `<div style="text-align:center; margin-bottom: 20px;">
    <h2 style="margin:0; font-size:14pt; font-weight:bold;">PEMERINTAH KABUPATEN MAHAKAM ULU</h2>
    <h2 style="margin:0; font-size:14pt; font-weight:bold;">${formattedOpdName}</h2>
    <p style="margin:0; font-size:10pt;">Jalan Gunung Belareq Gg. Dunhil RT. VII Kampung Ujoh Bilang Kecamatan Long Bagun</p>
    <p style="margin:0; font-size:10pt;">UJOH BILANG</p>
    <hr style="border:1px solid black; margin:10px 0;">
  </div>`;

  html += `<div style="text-align:center; margin-bottom: 20px;">
    <h2 style="margin:0; font-size:14pt; font-weight:bold;">LAPORAN HASIL EVALUASI ${source === 'pm' ? 'PENILAIAN MANDIRI (LHE PM)' : 'PENILAIAN INSPEKTORAT (LHE INSP)'}</h2>
    <h2 style="margin:0; font-size:14pt; font-weight:bold;">AKUNTABILITAS KINERJA INSTANSI PEMERINTAH (AKIP)</h2>
    <h2 style="margin:0; font-size:14pt; font-weight:bold;">${formattedOpdName} KABUPATEN MAHAKAM ULU ${year}</h2>
    <p style="margin:0; font-size:10pt;">Nomor: ....../..../LHE-${source === 'pm' ? 'PM' : 'INSP'}/${opdName}/2026</p>
  </div>`;

  html += `<h3 style="font-size:12pt; font-weight:bold; margin-top:20px;">I. PENDAHULUAN</h3><p>Laporan Hasil Evaluasi ${source === 'pm' ? 'Penilaian Mandiri (LHE PM)' : 'Penilaian Inspektorat (LHE INSP)'} Akuntabilitas Kinerja Instansi Pemerintah (AKIP) ${formattedOpdName} Kabupaten Mahakam Ulu Tahun Anggaran ${year} disusun sebagai potret kondisi akuntabilitas kinerja perangkat daerah berdasarkan hasil telaah atas dokumen dan catatan evaluasi SAKIP yang tersedia.</p>`;
  html += `<p>Evaluasi difokuskan pada ketersediaan bukti dukung, kualitas implementasi, serta pemanfaatan SAKIP pada empat komponen utama sesuai kerangka evaluasi dalam Peraturan Menteri Pendayagunaan Aparatur Negara dan Reformasi Birokrasi Nomor 88 Tahun 2021, Peraturan Bupati Mahakam Ulu Nomor 1 Tahun 2026 tentang Evaluasi Akuntabilitas Kinerja Instansi Pemerintah.</p>`;

  html += `<h4 style="font-size:12pt; font-weight:bold; margin-top:15px;">A. Dasar Hukum Evaluasi</h4><p>Sebagai landasan pijak yang memperkuat langkah kita bersama dalam mewujudkan tata kelola pemerintahan yang baik, pelaksanaan evaluasi atas Sistem Akuntabilitas Kinerja Instansi Pemerintah (SAKIP) di lingkungan ${formattedOpdName} Kabupaten Mahakam Ulu berpedoman pada regulasi berikut:</p><ol>`;
  html += `<li>Undang-Undang Nomor 23 Tahun 2014 tentang Pemerintahan Daerah sebagaimana telah beberapa kali diubah terakhir dengan Undang-Undang Nomor 9 Tahun 2015.</li><li>Peraturan Presiden Republik Indonesia Nomor 29 Tahun 2014 tentang Sistem Akuntabilitas Kinerja Instansi Pemerintah.</li><li>Peraturan Pemerintah Nomor 12 Tahun 2017 tentang Pembinaan dan Pengawasan Penyelenggaraan Pemerintah Daerah.</li><li>Peraturan Pemerintah Nomor 13 Tahun 2019 tentang Pelaporan dan Evaluasi Penyelenggaraan Pemerintah Daerah.</li><li>Peraturan Menteri Pendayagunaan Aparatur Negara dan Reformasi Birokrasi Nomor 88 Tahun 2021 tentang Pedoman Evaluasi Akuntabilitas Kinerja Instansi Pemerintah.</li><li>Peraturan Daerah Kabupaten Mahakam Ulu Nomor 14 Tahun 2016 tentang Pembentukan dan Susunan Perangkat Daerah, serta Peraturan Bupati Mahakam Ulu Nomor 27 Tahun 2016 tentang Susunan Organisasi dan Tata Kerja Perangkat Daerah.</li><li>Peraturan Bupati Mahakam Ulu Nomor 1 Tahun 2026 tentang Evaluasi Akuntabilitas Kinerja Instansi Pemerintah.</li><li>Keputusan Bupati Mahakam Ulu Nomor [700.1.1/K.6a/2025] tentang Program Kerja Pengawasan Tahunan (PKPT) Berbasis Risiko, yang ditindaklanjuti dengan Surat Perintah Tugas Inspektur Inspektorat Nomor: [090/20/INSPEKTORAT/III/2026 tanggal 02 Maret 2026.]</li></ol>`;

  html += `<h4 style="font-size:12pt; font-weight:bold; margin-top:15px;">B. Latar Belakang Evaluasi</h4><p>Saat ini terus bergerak maju dalam menyempurnakan tata kelola birokrasinya. Kita bersama-sama sedang berada dalam masa transisi yang positif, bergeser dari budaya kerja yang sekadar berfokus pada kelengkapan administrasi dan penyerapan anggaran, menuju budaya kerja yang benar-benar memberikan hasil (outcome) dan manfaat nyata bagi masyarakat luas. Dalam perjalanan mulia ini, SAKIP hadir bukan sebagai beban tambahan, melainkan sebagai instrumen navigasi yang membantu kita memastikan bahwa setiap program dan anggaran berjalan di jalur yang tepat.</p>`;

  html += `<h3 style="font-size:12pt; font-weight:bold; margin-top:20px;">II. GAMBARAN UMUM HASIL EVALUASI</h3><p>Secara keseluruhan, ${formattedOpdName} memperoleh nilai ${source === 'pm' ? 'Penilaian Mandiri' : 'Penilaian Inspektorat'}/hasil evaluasi sebesar ${totalNilai.toFixed(2)} dengan predikat ${predikat}. Nilai tersebut merupakan hasil akumulasi empat komponen SAKIP.</p>`;

  html += `<table border="1" style="border-collapse: collapse; width: 100%; table-layout: fixed; margin-top: 10px; font-size: 10pt;">`;
  html += `<colgroup>
            <col style="width: 5%;">
            <col style="width: 45%;">
            <col style="width: 20%;">
            <col style="width: 30%;">
           </colgroup>`;

  if (source === 'pm') {
    html += `<tr style="background: #e8e8e8;"><th style="padding: 6px; width: 5%;">No</th><th style="padding: 6px; width: 45%;">Komponen / Sub Komponen / Kriteria</th><th style="padding: 6px; width: 20%;">Bobot</th><th style="padding: 6px; width: 30%;">Nilai PM</th></tr>`;
  } else {
    html += `<tr style="background: #e8e8e8;"><th style="padding: 6px; width: 5%;">No</th><th style="padding: 6px; width: 45%;">Komponen / Sub Komponen / Kriteria</th><th style="padding: 6px; width: 20%;">Bobot</th><th style="padding: 6px; width: 30%;">Nilai Inspektorat</th></tr>`;
  }

  komponenList.forEach((komponen, idxKomponen) => {
    const kompGroup = groupedData[komponen];
    if (!kompGroup) return;

    html += `<tr style="background: #d1e7dd; font-weight: bold;">
      <td style="padding: 6px; text-align:center;">${idxKomponen + 1}</td>
      <td style="padding: 6px;">${komponen} (${kompGroup.totalBobot}%)</td>
      <td style="padding: 6px; text-align:center;">${kompGroup.totalBobot.toFixed(2)}</td>
      <td style="padding: 6px; text-align:center;">${kompGroup.totalNilai.toFixed(2)}</td>
    </tr>`;

    Object.keys(kompGroup.subKomponen).forEach(subKey => {
      const subGroup = kompGroup.subKomponen[subKey];

      html += `<tr style="background: #f8f9fa; font-weight: bold;">
        <td style="padding: 6px;"></td>
        <td style="padding: 6px; padding-left: 20px;">${subKey} (${subGroup.totalBobot}%)</td>
        <td style="padding: 6px; text-align:center;">${subGroup.totalBobot.toFixed(2)}</td>
        <td style="padding: 6px; text-align:center;">${subGroup.totalNilai.toFixed(2)}</td>
      </tr>`;

      subGroup.kriteria.forEach((row, idxKriteria) => {
        const pmScore = row.RuleMap[row.pmGrade] || 0;
        const inspScore = row.RuleMap[row.inspGrade] || 0;

        html += `<tr>
          <td style="padding: 6px; text-align:center; word-wrap: break-word;">${idxKriteria + 1}</td>
          <td style="padding: 6px; padding-left: 40px; word-wrap: break-word;">${normalizeText(row.Kriteria)}</td>
          <td style="padding: 6px; text-align:center;">${row.Bobot}</td>
          <td style="padding: 6px; text-align:center;">${source === 'pm' ? pmScore.toFixed(2) : inspScore.toFixed(2)}</td>
        </tr>`;
      });
    });
  });

  html += `</table>`;

  html += `<h3 style="font-size:12pt; font-weight:bold; margin-top:20px;">III. ANALISIS PER KOMPONEN</h3>`;
  komponenList.forEach((k, idx) => { const nilai = groupedData[k] ? groupedData[k].totalNilai : 0; const bobot = groupedData[k] ? groupedData[k].totalBobot : 0; 
    const pct = totalMax > 0 ? (nilai / totalMax * 100).toFixed(2) : "0.00"; 
    html += `<h4 style="font-size:12pt; font-weight:bold; margin-top:10px;">${idx+1}. ${k} - nilai ${nilai.toFixed(2)} dari maksimal ${bobot.toFixed(2)}</h4><p>Komponen ini memperoleh nilai ${nilai.toFixed(2)} dari maksimal ${bobot.toFixed(2)}. Kontribusi terhadap total keseluruhan: ${pct}%.</p>`; 
    
    const status = statusKriteria[k] || { terpenuhi: [], belum: [], catatan: [] }; 
    
    if (status.terpenuhi.length > 0) { html += `<p><b>Kriteria yang sudah terpenuhi:</b></p><ul>`; status.terpenuhi.forEach(item => html += `<li>${item}</li>`); html += `</ul>`; } 
    if (status.belum.length > 0) { html += `<p><b>Kriteria yang belum terpenuhi:</b></p><ul>`; status.belum.forEach(item => html += `<li>${item}</li>`); html += `</ul>`; } 
    
    if (status.catatan.length > 0) {
      html += `<p><b>Catatan ${source === 'pm' ? 'Penilaian Mandiri' : 'Inspektorat'}:</b></p><ul>`;
      status.catatan.forEach(cat => {
        html += `<li>${formatNoteToRecommendation(cat)}</li>`;
      });
      html += `</ul>`;
    }
  });

  html += `<h3 style="font-size:12pt; font-weight:bold; margin-top:20px;">IV. REKOMENDASI PERBAIKAN</h3><ul>`;
  rekomendasi.forEach(r => html += `<li>${normalizeText(r)}</li>`);
  html += `</ul>`;

  html += `<h3 style="font-size:12pt; font-weight:bold; margin-top:20px;">V. PENUTUP</h3><p>${closingParagraph}</p>`;
  html += `<br><br><div style="text-align:right;"><p style="margin:0;">Ujoh Bilang, ${new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })}</p><p style="margin:0;">${source === 'pm' ? `Kepala ${formattedOpdName}` : 'Inspektur Kabupaten Mahakam Ulu'}</p><br><br><p style="margin:0;">_______________________</p><p style="margin:0;">Nama Lengkap</p><p style="margin:0;">NIP. ............................</p></div>`;
  html += `</body></html>`;

  return { html, aiProvider, totalNilai, predikat };
}

// ============ MAIN HANDLER ============
export const onRequest = async ({ request, env }) => {
  const ACCESS_PASSWORD = env.ACCESS_PASSWORD; const INSP_PASSWORD = env.INSP_PASSWORD; const DELETE_PASSWORD = env.DELETE_PASSWORD;
  const url = new URL(request.url); let params = {}; let action = url.searchParams.get('action') || '';
  
  // Ambil semua parameter dari query string
  url.searchParams.forEach((value, key) => { params[key] = value; });

  // Hanya parse JSON jika body adalah JSON (bukan multipart/form-data)
  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      try { params = await request.json(); if (!action && params.action) action = params.action; } catch (e) { return jsonResponse({ status: 'error', msg: 'Invalid JSON body' }); }
    }
  }

  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });

  const year = params.year || '2026';
  // Ambil IP dari header Cloudflare
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';

  try {
    switch (action) {
      case 'verifyPasswordPM': { 
        await checkRateLimit(env, clientIp, 'verifyPasswordPM', 5, 10 * 60 * 1000);
        const password = params.password || '';
        return jsonResponse({ status: password === ACCESS_PASSWORD ? 'success' : 'error', msg: password === ACCESS_PASSWORD ? 'Password benar' : 'Password salah' }); 
      }
      case 'verifyPasswordInsp': { 
        await checkRateLimit(env, clientIp, 'verifyPasswordInsp', 5, 10 * 60 * 1000);
        const password = params.password || '';
        return jsonResponse({ status: password === INSP_PASSWORD ? 'success' : 'error', msg: password === INSP_PASSWORD ? 'Password benar' : 'Password salah' }); 
      }
      case 'verifyPasswordDeleteYear': case 'verifyPasswordDeleteOPD': { 
        await checkRateLimit(env, clientIp, 'verifyPasswordDelete', 5, 10 * 60 * 1000);
        const password = params.password || '';
        return jsonResponse({ status: password === DELETE_PASSWORD ? 'success' : 'error', msg: password === DELETE_PASSWORD ? 'Password benar' : 'Password salah' }); 
      }
      case 'getYears': { const { results } = await env.DB.prepare("SELECT year FROM years ORDER BY year DESC").all(); const years = results.map(r => r.year); if (!years.includes(2026)) years.push(2026); return jsonResponse([...new Set(years)].sort((a,b) => b - a)); }
      case 'addYear': { 
        if (!params.year) return jsonResponse({ status: 'error', msg: 'Tahun wajib diisi' });
        await env.DB.prepare("INSERT OR IGNORE INTO years (year) VALUES (?)").bind(params.year).run(); return jsonResponse({ status: 'success', msg: 'Tahun ' + params.year + ' berhasil ditambahkan.' }); 
      }
      case 'deleteYear': { 
        if (!params.year) return jsonResponse({ status: 'error', msg: 'Tahun wajib diisi' });
        await env.DB.prepare("DELETE FROM data_scores WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM opds WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM qa_status WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM evidence WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM prev_scores WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM years WHERE year = ?").bind(params.year).run(); return jsonResponse({ status: 'success', msg: 'Tahun ' + params.year + ' berhasil dihapus.' }); 
      }
      case 'getAllOPDs': { const { results } = await env.DB.prepare("SELECT opd_name FROM opds WHERE year = ? ORDER BY opd_name").bind(year).all(); return jsonResponse(results.map(r => r.opd_name)); }
      case 'addOPD': { 
        const opdName = sanitizeString(params.opdName, 100);
        if (!opdName) return jsonResponse({ status: 'error', msg: 'Nama OPD kosong' }); 
        const existing = await env.DB.prepare("SELECT id FROM opds WHERE year = ? AND opd_name = ?").bind(year, opdName).first(); 
        if (existing) return jsonResponse({ status: 'error', msg: 'OPD sudah ada!' }); 
        await env.DB.prepare("INSERT INTO opds (year, opd_name) VALUES (?, ?)").bind(year, opdName).run(); 
        return jsonResponse({ status: 'success', msg: 'OPD ' + opdName + ' berhasil ditambahkan.' }); 
      }
      case 'deleteOPD': { 
        const opdName = sanitizeString(params.opdName, 100);
        if (!opdName) return jsonResponse({ status: 'error', msg: 'Nama OPD kosong' });
        await env.DB.prepare("DELETE FROM data_scores WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); await env.DB.prepare("DELETE FROM opds WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); await env.DB.prepare("DELETE FROM qa_status WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); await env.DB.prepare("DELETE FROM evidence WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); await env.DB.prepare("DELETE FROM prev_scores WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); return jsonResponse({ status: 'success', msg: 'OPD ' + opdName + ' berhasil dihapus.' }); 
      }
      case 'getMasterData': return jsonResponse(getMasterData());
      case 'savePMData': case 'saveInspData': { 
        const { opdName } = params; 
        if (!opdName) return jsonResponse({ status: 'error', msg: 'Nama OPD kosong' });
        const data = params.data || []; 
        const role = action === 'savePMData' ? 'pm' : 'insp'; 
        const master = getMasterData(); 
        if (data.length !== master.length) return jsonResponse({ status: 'error', msg: 'Data tidak lengkap' }); 
        for (let i = 0; i < master.length; i++) { 
          const critId = master[i].ID; 
          const item = data[i]; 
          const grade = sanitizeString(item.grade || '', 5);
          const note = sanitizeString(item.note || '', 500);
          const existing = await env.DB.prepare("SELECT id FROM data_scores WHERE year = ? AND opd_name = ? AND criteria_id = ?").bind(year, opdName, critId).first(); 
          if (existing) { 
            if (role === 'pm') await env.DB.prepare("UPDATE data_scores SET pm_grade = ?, pm_note = ? WHERE id = ?").bind(grade, note, existing.id).run(); 
            else await env.DB.prepare("UPDATE data_scores SET insp_grade = ?, insp_note = ? WHERE id = ?").bind(grade, note, existing.id).run(); 
          } else { 
            if (role === 'pm') await env.DB.prepare("INSERT INTO data_scores (year, opd_name, criteria_id, pm_grade, pm_note) VALUES (?, ?, ?, ?, ?)").bind(year, opdName, critId, grade, note).run(); 
            else await env.DB.prepare("INSERT INTO data_scores (year, opd_name, criteria_id, insp_grade, insp_note) VALUES (?, ?, ?, ?, ?)").bind(year, opdName, critId, grade, note).run(); 
          } 
        } 
        return jsonResponse({ status: 'success', msg: 'Data berhasil disimpan.' }); 
      }
      case 'saveQAStatus': { 
        const { opdName, status } = params; 
        if (!opdName || !status) return jsonResponse({ status: 'error', msg: 'Data tidak lengkap' });
        const cleanStatus = sanitizeString(status, 20);
        await env.DB.prepare("INSERT OR REPLACE INTO qa_status (year, opd_name, status) VALUES (?, ?, ?)").bind(year, opdName, cleanStatus).run(); 
        return jsonResponse({ status: 'success', msg: 'Status QA berhasil disimpan.' }); 
      }
      case 'savePrevScores': { 
        const { opdName, scores } = params; 
        if (!opdName || !scores) return jsonResponse({ status: 'error', msg: 'Data tidak lengkap' });
        // Validasi scores object
        const cleanScores = {};
        for (const [k, v] of Object.entries(scores)) {
          cleanScores[sanitizeString(k, 50)] = parseFloat(v) || 0;
        }
        await savePrevScores(year, opdName, cleanScores, env); 
        return jsonResponse({ status: 'success', msg: 'Nilai tahun sebelumnya berhasil disimpan.' }); 
      }
      case 'getPMDataForInspector': { 
        const { opdName } = params; 
        if (!opdName) return jsonResponse({ status: 'error', msg: 'Nama OPD kosong' });
        const result = await getPMDataForInspectorData(year, opdName, env); 
        const prevScores = await getPrevScores(year, opdName, env); 
        result.prevScores = prevScores; 
        return jsonResponse(result); 
      }
      
      case 'getOPDListDetails': { 
        const bulk = await getBulkData(year, env); 
        return jsonResponse(bulk.map(o => ({ name: o.opd_name, pmScore: o.pmTotal, inspScore: o.inspTotal, progress: o.progress, qaStatus: o.qaApipStatus }))); 
      }
      
      case 'getDashboardData': { 
        const cacheUrl = new URL(request.url); 
        const cacheKey = new Request(cacheUrl.toString());
        const cache = caches.default;
        const cached = await cache.match(cacheKey);
        if (cached) return cached; 

        const bulk = await getBulkData(year, env);
        let totalOPD = bulk.length; let minPM = Infinity, minInsp = Infinity; let topPM = {name:'', value:-1}, topInsp = {name:'', value:-1}; let qaCount = {selesai:0,proses:0,belum:0}; let evidenceLengkapCount = 0; let totalProgress = 0;
        if (totalOPD > 0) { 
          bulk.forEach(o => { const pm = parseFloat(o.pmTotal); const insp = parseFloat(o.inspTotal); const progress = parseFloat(o.progress); 
            if (pm > 0 && pm < minPM) minPM = pm; if (insp > 0 && insp < minInsp) minInsp = insp; if (pm > topPM.value) topPM = {name: o.opd_name, value: pm}; if (insp > topInsp.value) topInsp = {name: o.opd_name, value: insp}; 
            if (o.qaApipStatus === 'Selesai') qaCount.selesai++; else if (o.qaApipStatus === 'Proses') qaCount.proses++; else qaCount.belum++; totalProgress += progress; if (pm > 0) evidenceLengkapCount++; 
          }); 
        }
        if (minPM === Infinity) minPM = 0; if (minInsp === Infinity) minInsp = 0; 
        const respBody = { year, totalOPD, topPM: { name: topPM.name || 'Belum ada', value: (Number(topPM.value)||0).toFixed(2) }, topInsp: { name: topInsp.name || 'Belum ada', value: (Number(topInsp.value)||0).toFixed(2) }, minPM: (Number(minPM)||0).toFixed(2), minInsp: (Number(minInsp)||0).toFixed(2), avgProgress: (Number(totalProgress)/totalOPD).toFixed(0) + '%', qaCount, evidenceLengkap: (evidenceLengkapCount/totalOPD*100).toFixed(0) + '%' }; 
        const res = new Response(JSON.stringify(respBody), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30' } }); 
        await cache.put(cacheKey, res.clone()); return res; 
      }

      case 'getChartData': { 
        const bulk = await getBulkData(year, env); 
        const labels = [], inspScores = [], pmScores = [], qaStatus = []; 
        bulk.forEach(o => { labels.push(o.opd_name); pmScores.push(Number(o.pmTotal).toFixed(2)); inspScores.push(Number(o.inspTotal).toFixed(2)); qaStatus.push(o.qaApipStatus); }); 
        return jsonResponse({ labels, inspScores, pmScores, qaStatus, totalOPD: bulk.length }); 
      }
      
      // ===== PERUBAHAN: UPLOAD VIA FORMDATA + STREAM =====
      case 'uploadEvidence': { 
        const { opdName, criteriaId, fileName, mimeType } = params; 
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) return jsonResponse({ status: 'error', msg: 'File tidak ditemukan' });
        
        if (file.size > 10 * 1024 * 1024) {
          return jsonResponse({ status: 'error', msg: 'File melebihi batas 10MB!' });
        }

        const r2Path = `sakip/${year}/${sanitizeString(opdName, 100)}/${sanitizeString(criteriaId, 50)}/${Date.now()}_${sanitizeString(fileName, 100)}`; 
        await env.EVIDENCE_BUCKET.put(r2Path, file.stream(), { httpMetadata: { contentType: mimeType || 'application/octet-stream' } }); 
        const publicUrl = `https://pub-6825f3819d9d46089a296f5d492fab22.r2.dev/${r2Path}`; 
        let gdriveId = null; 
        if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) { 
          const bytes = new Uint8Array(await file.arrayBuffer());
          try { gdriveId = await uploadToGoogleDrive(env, r2Path, fileName, bytes, env.GOOGLE_DRIVE_FOLDER_ID); } catch (err) { console.error('Gagal upload ke Google Drive:', err.message); } 
        } 
        await env.DB.prepare("INSERT INTO evidence (year, opd_name, criteria_id, url, gdrive_id, file_name) VALUES (?, ?, ?, ?, ?, ?)").bind(year, opdName, criteriaId, publicUrl, gdriveId, fileName).run(); 
        return jsonResponse({ status: 'success', url: publicUrl, gdriveId }); 
      }
      case 'deleteEvidence': { 
        const { opdName, criteriaId, url, gdriveId } = params; 
        const cleanUrl = url.split('?')[0]; const marker = 'r2.dev/'; const idx = cleanUrl.indexOf(marker); if (idx !== -1) { const r2Path = decodeURIComponent(cleanUrl.substring(idx + marker.length)); await env.EVIDENCE_BUCKET.delete(r2Path); } if (gdriveId) { try { await deleteGoogleDriveFile(env, gdriveId); } catch (err) { return jsonResponse({ status: 'error', msg: 'Gagal hapus di Google Drive: ' + err.message }); } } await env.DB.prepare("DELETE FROM evidence WHERE url = ? AND year = ? AND opd_name = ? AND criteria_id = ?").bind(url, year, opdName, criteriaId).run(); return jsonResponse({ status: 'success', msg: 'File berhasil dihapus.' }); }
      case 'generateLaporanMandiri': { const { opdName } = params; const { html, aiProvider } = await generateLaporanHtml({ year, opdName, env, source: 'pm' }); const bytes = new TextEncoder().encode(html); const r2Path = `laporan/${year}/PM_${opdName}_${Date.now()}.html`; await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: 'text/html' } }); const laporanUrl = `https://pub-6825f3819d9d46089a296f5d492fab22.r2.dev/${r2Path}`; let gdocsUrl = null; if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) { try { gdocsUrl = await createGoogleDoc(env, html, `LHE_PM_${opdName}_${year}`, env.GOOGLE_DRIVE_FOLDER_ID); } catch (e) { console.error('Gagal membuat Google Docs:', e); } } return jsonResponse({ status: 'success', url: laporanUrl, gdocsUrl: gdocsUrl, aiProvider, type: 'PM' }); }
      case 'generateLaporanInspektorat': { const { opdName } = params; const { html, aiProvider } = await generateLaporanHtml({ year, opdName, env, source: 'insp' }); const bytes = new TextEncoder().encode(html); const r2Path = `laporan/${year}/INSP_${opdName}_${Date.now()}.html`; await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: 'text/html' } }); const laporanUrl = `https://pub-6825f3819d9d46089a296f5d492fab22.r2.dev/${r2Path}`; let gdocsUrl = null; if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) { try { gdocsUrl = await createGoogleDoc(env, html, `LHE_INSP_${opdName}_${year}`, env.GOOGLE_DRIVE_FOLDER_ID); } catch (e) { console.error('Gagal membuat Google Docs:', e); } } return jsonResponse({ status: 'success', url: laporanUrl, gdocsUrl: gdocsUrl, aiProvider, type: 'INSP' }); }
      default: return jsonResponse({ status: 'error', msg: 'Aksi tidak dikenal: ' + action });
    }
  } catch (err) { console.error('Error di handler:', err); return jsonResponse({ status: 'error', msg: 'Error: ' + err.message }); }
};
