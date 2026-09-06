import { getMasterData } from './sakipMasterData.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
  });
}

// ============ HELPER NORMALISASI ============
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

// ============ END NORMALISASI ============

// ============ GOOGLE DRIVE INTEGRATION ============
// (Fungsi Google Drive tetap dipertahankan, tapi optional)
async function getGoogleAccessToken(env) {
  const { GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN } = env;
  if (!GOOGLE_DRIVE_CLIENT_ID || !GOOGLE_DRIVE_CLIENT_SECRET || !GOOGLE_DRIVE_REFRESH_TOKEN) throw new Error('Google Drive credentials not configured');
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: GOOGLE_DRIVE_CLIENT_ID, client_secret: GOOGLE_DRIVE_CLIENT_SECRET, refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) throw new Error('Failed to get Google Drive access token: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ... (fungsi Drive lainnya tetap ada, tapi saya singkat agar fokus ke upload)

// ============ END GOOGLE DRIVE INTEGRATION ============

// ============ HELPER FUNCTIONS ============
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
      return {
        ...row,
        pmGrade: sc.pm_grade || "",
        pmNote: sc.pm_note || "",
        inspGrade: sc.insp_grade || "",
        inspNote: sc.insp_note || "",
        evUrls: (evMap[opd.opd_name] || {})[row.ID] || [],
        qaApipStatus: qaMap[opd.opd_name] || 'Belum'
      };
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

  // ... (AI API key fallback tetap sama)

  console.warn('Semua AI Gagal. Menggunakan Fallback Template.');
  const catatanList = [];
  Object.keys(kriteriaBelum).forEach(komp => {
    if (kriteriaBelum[komp] && kriteriaBelum[komp].catatan) catatanList.push(...kriteriaBelum[komp].catatan);
  });
  return { list: buildRekomendasiRingkas(maxBobot, nilaiKomponen, data, source, catatanList), provider: "Template" };
}

async function generateClosingWithAI(env, data, totalNilai, predikat, opdName, year, source) {
  // ... (Fungsi closing tetap sama, dipersingkat)
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

  // ... (HTML Laporan tetap sama seperti sebelumnya)

  return { html, aiProvider, totalNilai, predikat };
}

// ============ MAIN HANDLER ============
export const onRequest = async ({ request, env }) => {
  const ACCESS_PASSWORD = env.ACCESS_PASSWORD; const INSP_PASSWORD = env.INSP_PASSWORD; const DELETE_PASSWORD = env.DELETE_PASSWORD;
  const url = new URL(request.url); let params = {}; let action = url.searchParams.get('action') || '';
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  if (request.method === 'POST') { try { params = await request.json(); if (!action && params.action) action = params.action; } catch (e) { return jsonResponse({ status: 'error', msg: 'Invalid JSON body' }); } } else { url.searchParams.forEach((value, key) => { params[key] = value; }); }
  const year = params.year || '2026';

  try {
    switch (action) {
      case 'verifyPasswordPM': return jsonResponse({ status: params.password === ACCESS_PASSWORD ? 'success' : 'error', msg: params.password === ACCESS_PASSWORD ? 'Password benar' : 'Password salah' });
      case 'verifyPasswordInsp': return jsonResponse({ status: params.password === INSP_PASSWORD ? 'success' : 'error', msg: params.password === INSP_PASSWORD ? 'Password benar' : 'Password salah' });
      case 'verifyPasswordDeleteYear': case 'verifyPasswordDeleteOPD': return jsonResponse({ status: params.password === DELETE_PASSWORD ? 'success' : 'error', msg: params.password === DELETE_PASSWORD ? 'Password benar' : 'Password salah' });
      case 'getYears': { const { results } = await env.DB.prepare("SELECT year FROM years ORDER BY year DESC").all(); const years = results.map(r => r.year); if (!years.includes(2026)) years.push(2026); return jsonResponse([...new Set(years)].sort((a,b) => b - a)); }
      case 'addYear': { await env.DB.prepare("INSERT OR IGNORE INTO years (year) VALUES (?)").bind(params.year).run(); return jsonResponse({ status: 'success', msg: 'Tahun ' + params.year + ' berhasil ditambahkan.' }); }
      case 'deleteYear': { await env.DB.prepare("DELETE FROM data_scores WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM opds WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM qa_status WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM evidence WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM prev_scores WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM years WHERE year = ?").bind(params.year).run(); return jsonResponse({ status: 'success', msg: 'Tahun ' + params.year + ' berhasil dihapus.' }); }
      case 'getAllOPDs': { const { results } = await env.DB.prepare("SELECT opd_name FROM opds WHERE year = ? ORDER BY opd_name").bind(year).all(); return jsonResponse(results.map(r => r.opd_name)); }
      case 'addOPD': { const opdName = params.opdName; if (!opdName) return jsonResponse({ status: 'error', msg: 'Nama OPD kosong' }); const existing = await env.DB.prepare("SELECT id FROM opds WHERE year = ? AND opd_name = ?").bind(year, opdName).first(); if (existing) return jsonResponse({ status: 'error', msg: 'OPD sudah ada!' }); await env.DB.prepare("INSERT INTO opds (year, opd_name) VALUES (?, ?)").bind(year, opdName).run(); return jsonResponse({ status: 'success', msg: 'OPD ' + opdName + ' berhasil ditambahkan.' }); }
      case 'deleteOPD': { const opdName = params.opdName; await env.DB.prepare("DELETE FROM data_scores WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); await env.DB.prepare("DELETE FROM opds WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); await env.DB.prepare("DELETE FROM qa_status WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); await env.DB.prepare("DELETE FROM evidence WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); await env.DB.prepare("DELETE FROM prev_scores WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); return jsonResponse({ status: 'success', msg: 'OPD ' + opdName + ' berhasil dihapus.' }); }
      case 'getMasterData': return jsonResponse(getMasterData());
      case 'savePMData': case 'saveInspData': { const { opdName, data } = params; const role = action === 'savePMData' ? 'pm' : 'insp'; const master = getMasterData(); if (data.length !== master.length) return jsonResponse({ status: 'error', msg: 'Data tidak lengkap' }); for (let i = 0; i < master.length; i++) { const critId = master[i].ID; const item = data[i]; const existing = await env.DB.prepare("SELECT id FROM data_scores WHERE year = ? AND opd_name = ? AND criteria_id = ?").bind(year, opdName, critId).first(); if (existing) { if (role === 'pm') await env.DB.prepare("UPDATE data_scores SET pm_grade = ?, pm_note = ? WHERE id = ?").bind(item.grade || '', item.note || '', existing.id).run(); else await env.DB.prepare("UPDATE data_scores SET insp_grade = ?, insp_note = ? WHERE id = ?").bind(item.grade || '', item.note || '', existing.id).run(); } else { if (role === 'pm') await env.DB.prepare("INSERT INTO data_scores (year, opd_name, criteria_id, pm_grade, pm_note) VALUES (?, ?, ?, ?, ?)").bind(year, opdName, critId, item.grade || '', item.note || '').run(); else await env.DB.prepare("INSERT INTO data_scores (year, opd_name, criteria_id, insp_grade, insp_note) VALUES (?, ?, ?, ?, ?)").bind(year, opdName, critId, item.grade || '', item.note || '').run(); } } return jsonResponse({ status: 'success', msg: 'Data berhasil disimpan.' }); }
      case 'saveQAStatus': { const { opdName, status } = params; await env.DB.prepare("INSERT OR REPLACE INTO qa_status (year, opd_name, status) VALUES (?, ?, ?)").bind(year, opdName, status).run(); return jsonResponse({ status: 'success', msg: 'Status QA berhasil disimpan.' }); }
      case 'savePrevScores': { const { opdName, scores } = params; await savePrevScores(year, opdName, scores, env); return jsonResponse({ status: 'success', msg: 'Nilai tahun sebelumnya berhasil disimpan.' }); }
      case 'getPMDataForInspector': { const { opdName } = params; const result = await getPMDataForInspectorData(year, opdName, env); const prevScores = await getPrevScores(year, opdName, env); result.prevScores = prevScores; return jsonResponse(result); }
      
      // OPTIMASI: Panggil Batch Data sekali untuk semua OPD
      case 'getOPDListDetails': { 
        const bulk = await getBulkData(year, env); 
        return jsonResponse(bulk.map(o => ({ name: o.opd_name, pmScore: o.pmTotal, inspScore: o.inspTotal, progress: o.progress, qaStatus: o.qaApipStatus }))); 
      }
      
      // OPTIMASI: Caching Dashboard Data (30 detik)
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
      
      // === PERUBAHAN PENTING: Upload Binary Langsung (tanpa Base64) ===
      case 'uploadEvidence': { 
        const { opdName, criteriaId, fileName, mimeType } = params; 
        // Ambil raw binary dari request body (bukan JSON base64)
        const buffer = await request.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Validasi ukuran file (maksimal 10MB = 10 * 1024 * 1024 bytes)
        if (bytes.length > 10 * 1024 * 1024) {
          return jsonResponse({ status: 'error', msg: 'File melebihi batas 10MB!' });
        }

        // Struktur folder per OPD
        const r2Path = `sakip/${year}/${opdName}/${criteriaId}/${Date.now()}_${fileName}`; 
        await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: mimeType || 'application/octet-stream' } }); 
        const publicUrl = `https://pub-6825f3819d9d46089a296f5d492fab22.r2.dev/${r2Path}`; 
        let gdriveId = null; 
        if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) { 
          try { gdriveId = await uploadToGoogleDrive(env, r2Path, fileName, bytes, env.GOOGLE_DRIVE_FOLDER_ID); } catch (err) { console.error('Gagal upload ke Google Drive:', err.message); } 
        } 
        await env.DB.prepare("INSERT INTO evidence (year, opd_name, criteria_id, url, gdrive_id, file_name) VALUES (?, ?, ?, ?, ?, ?)").bind(year, opdName, criteriaId, publicUrl, gdriveId, fileName).run(); 
        return jsonResponse({ status: 'success', url: publicUrl, gdriveId }); 
      }
      case 'deleteEvidence': { const { opdName, criteriaId, url, gdriveId } = params; const cleanUrl = url.split('?')[0]; const marker = 'r2.dev/'; const idx = cleanUrl.indexOf(marker); if (idx !== -1) { const r2Path = decodeURIComponent(cleanUrl.substring(idx + marker.length)); await env.EVIDENCE_BUCKET.delete(r2Path); } if (gdriveId) { try { await deleteGoogleDriveFile(env, gdriveId); } catch (err) { return jsonResponse({ status: 'error', msg: 'Gagal hapus di Google Drive: ' + err.message }); } } await env.DB.prepare("DELETE FROM evidence WHERE url = ? AND year = ? AND opd_name = ? AND criteria_id = ?").bind(url, year, opdName, criteriaId).run(); return jsonResponse({ status: 'success', msg: 'File berhasil dihapus.' }); }
      case 'generateLaporanMandiri': { const { opdName } = params; const { html, aiProvider } = await generateLaporanHtml({ year, opdName, env, source: 'pm' }); const bytes = new TextEncoder().encode(html); const r2Path = `laporan/${year}/PM_${opdName}_${Date.now()}.html`; await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: 'text/html' } }); const laporanUrl = `https://pub-6825f3819d9d46089a296f5d492fab22.r2.dev/${r2Path}`; let gdocsUrl = null; if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) { try { gdocsUrl = await createGoogleDoc(env, html, `LHE_PM_${opdName}_${year}`, env.GOOGLE_DRIVE_FOLDER_ID); } catch (e) { console.error('Gagal membuat Google Docs:', e); } } return jsonResponse({ status: 'success', url: laporanUrl, gdocsUrl: gdocsUrl, aiProvider, type: 'PM' }); }
      case 'generateLaporanInspektorat': { const { opdName } = params; const { html, aiProvider } = await generateLaporanHtml({ year, opdName, env, source: 'insp' }); const bytes = new TextEncoder().encode(html); const r2Path = `laporan/${year}/INSP_${opdName}_${Date.now()}.html`; await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: 'text/html' } }); const laporanUrl = `https://pub-6825f3819d9d46089a296f5d492fab22.r2.dev/${r2Path}`; let gdocsUrl = null; if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) { try { gdocsUrl = await createGoogleDoc(env, html, `LHE_INSP_${opdName}_${year}`, env.GOOGLE_DRIVE_FOLDER_ID); } catch (e) { console.error('Gagal membuat Google Docs:', e); } } return jsonResponse({ status: 'success', url: laporanUrl, gdocsUrl: gdocsUrl, aiProvider, type: 'INSP' }); }
      default: return jsonResponse({ status: 'error', msg: 'Aksi tidak dikenal: ' + action });
    }
  } catch (err) { console.error('Error di handler:', err); return jsonResponse({ status: 'error', msg: 'Error: ' + err.message }); }
};
