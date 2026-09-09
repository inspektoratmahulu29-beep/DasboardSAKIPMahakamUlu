import { getMasterData } from './sakipMasterData.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
  });
}

function sanitizeInput(str) {
  if (!str) return "";
  return String(str)
    .replace(/[<>"'`\\]/g, '')
    .replace(/\.\./g, '')
    .replace(/[\/:*?"<>|#%{}]/g, ' ')
    .trim()
    .substring(0, 200);
}

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

async function checkRateLimit(env, ip, action) {
  const now = Date.now();
  const limit = 5;
  const windowMs = 10 * 60 * 1000;
  const { results } = await env.DB.prepare("SELECT COUNT(*) as count FROM rate_limits WHERE ip = ? AND action = ? AND timestamp > ?").bind(ip, action, now - windowMs).all();
  if (results[0].count >= limit) throw new Error('Terlalu banyak percobaan. Coba lagi dalam 10 menit.');
  await env.DB.prepare("INSERT INTO rate_limits (ip, action, timestamp) VALUES (?, ?, ?)").bind(ip, action, now).run();
}

// ====== (Semua helper Google Drive, AI, dll. sama seperti sebelumnya - salin dari kode yang sudah Anda punya) ======

async function getBulkData(year, env) {
  const [opds, scores, evidence, qa] = await Promise.all([
    env.DB.prepare("SELECT opd_name FROM opds WHERE year = ? ORDER BY opd_name").bind(year).all(),
    env.DB.prepare("SELECT opd_name, criteria_id, pm_grade, pm_note, insp_grade, insp_note FROM data_scores WHERE year = ?").bind(year).all(),
    env.DB.prepare("SELECT opd_name, criteria_id, url, gdrive_id, file_name, upload_date FROM evidence WHERE year = ?").bind(year).all(),
    env.DB.prepare("SELECT opd_name, status FROM qa_status WHERE year = ?").bind(year).all()
  ]);
  const scoreMap = {}, evMap = {}, qaMap = {};
  scores.results.forEach(row => { if (!scoreMap[row.opd_name]) scoreMap[row.opd_name] = {}; scoreMap[row.opd_name][row.criteria_id] = row; });
  evidence.results.forEach(row => { if (!evMap[row.opd_name]) evMap[row.opd_name] = {}; if (!evMap[row.opd_name][row.criteria_id]) evMap[row.opd_name][row.criteria_id] = []; evMap[row.opd_name][row.criteria_id].push({ url: row.url, fileName: row.file_name, date: row.upload_date }); });
  qa.results.forEach(row => { qaMap[row.opd_name] = row.status; });
  const master = getMasterData();
  master.forEach(row => { if (!row.RuleMap) row.RuleMap = {}; });
  return opds.results.map(opd => {
    const fullData = master.map(row => {
      const sc = (scoreMap[opd.opd_name] || {})[row.ID] || {};
      return { ...row, pmGrade: sc.pm_grade || "", pmNote: sc.pm_note || "", inspGrade: sc.insp_grade || "", inspNote: sc.insp_note || "", evUrls: (evMap[opd.opd_name] || {})[row.ID] || [], qaApipStatus: qaMap[opd.opd_name] || 'Belum' };
    });
    let pmTotal = 0, inspTotal = 0;
    fullData.forEach(row => { pmTotal += row.RuleMap[row.pmGrade] || 0; inspTotal += row.RuleMap[row.inspGrade] || 0; });
    const totalBobot = fullData.reduce((sum, row) => sum + (row.Bobot || 0), 0);
    return {
      opd_name: opd.opd_name, data: fullData,
      pmTotal: pmTotal.toFixed(2), inspTotal: inspTotal.toFixed(2),
      progress: totalBobot > 0 ? ((pmTotal / totalBobot) * 100).toFixed(0) + '%' : '0%',
      qaApipStatus: qaMap[opd.opd_name] || 'Belum'
    };
  });
}

// ====== (Sisakan semua fungsi AI, generateLaporan, dll. dari kode awal) ======

export const onRequest = async ({ request, env }) => {
  const url = new URL(request.url);
  let params = {};
  let action = url.searchParams.get('action') || '';
  url.searchParams.forEach((value, key) => { params[key] = value; });

  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      try { params = await request.json(); if (!action && params.action) action = params.action; } catch (e) { return jsonResponse({ status: 'error', msg: 'Invalid JSON body' }); }
    }
  }

  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });

  const year = params.year || '2026';
  const ACCESS_PASSWORD = env.ACCESS_PASSWORD, INSP_PASSWORD = env.INSP_PASSWORD, DELETE_PASSWORD = env.DELETE_PASSWORD;

  if (['verifyPasswordPM', 'verifyPasswordInsp', 'verifyPasswordDeleteYear', 'verifyPasswordDeleteOPD'].includes(action)) {
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    try { await checkRateLimit(env, clientIp, action); } catch (err) { return jsonResponse({ status: 'error', msg: err.message }, 429); }
  }

  try {
    switch (action) {
      case 'verifyPasswordPM': return jsonResponse({ status: params.password === ACCESS_PASSWORD ? 'success' : 'error', msg: params.password === ACCESS_PASSWORD ? 'Password benar' : 'Password salah' });
      case 'verifyPasswordInsp': return jsonResponse({ status: params.password === INSP_PASSWORD ? 'success' : 'error', msg: params.password === INSP_PASSWORD ? 'Password benar' : 'Password salah' });
      case 'verifyPasswordDeleteYear': case 'verifyPasswordDeleteOPD': return jsonResponse({ status: params.password === DELETE_PASSWORD ? 'success' : 'error', msg: params.password === DELETE_PASSWORD ? 'Password benar' : 'Password salah' });
      case 'getYears': { const { results } = await env.DB.prepare("SELECT year FROM years ORDER BY year DESC").all(); const years = results.map(r => r.year); if (!years.includes(2026)) years.push(2026); return jsonResponse([...new Set(years)].sort((a,b) => b - a)); }
      case 'addYear': { await env.DB.prepare("INSERT OR IGNORE INTO years (year) VALUES (?)").bind(params.year).run(); return jsonResponse({ status: 'success', msg: 'Tahun ' + params.year + ' berhasil ditambahkan.' }); }
      case 'deleteYear': { await env.DB.prepare("DELETE FROM data_scores WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM opds WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM qa_status WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM evidence WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM prev_scores WHERE year = ?").bind(params.year).run(); await env.DB.prepare("DELETE FROM years WHERE year = ?").bind(params.year).run(); return jsonResponse({ status: 'success', msg: 'Tahun ' + params.year + ' berhasil dihapus.' }); }
      case 'getAllOPDs': { const { results } = await env.DB.prepare("SELECT opd_name FROM opds WHERE year = ? ORDER BY opd_name").bind(year).all(); return jsonResponse(results.map(r => r.opd_name)); }
      case 'addOPD': { const opdName = sanitizeInput(params.opdName); if (!opdName) return jsonResponse({ status: 'error', msg: 'Nama OPD kosong' }); const existing = await env.DB.prepare("SELECT id FROM opds WHERE year = ? AND opd_name = ?").bind(year, opdName).first(); if (existing) return jsonResponse({ status: 'error', msg: 'OPD sudah ada!' }); await env.DB.prepare("INSERT INTO opds (year, opd_name) VALUES (?, ?)").bind(year, opdName).run(); return jsonResponse({ status: 'success', msg: 'OPD ' + opdName + ' berhasil ditambahkan.' }); }
      case 'deleteOPD': { const opdName = sanitizeInput(params.opdName); await env.DB.prepare("DELETE FROM data_scores WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); await env.DB.prepare("DELETE FROM opds WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); await env.DB.prepare("DELETE FROM qa_status WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); await env.DB.prepare("DELETE FROM evidence WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); await env.DB.prepare("DELETE FROM prev_scores WHERE year = ? AND opd_name = ?").bind(year, opdName).run(); return jsonResponse({ status: 'success', msg: 'OPD ' + opdName + ' berhasil dihapus.' }); }
      case 'getMasterData': return jsonResponse(getMasterData());
      case 'savePMData': case 'saveInspData': { const { opdName, data } = params; const role = action === 'savePMData' ? 'pm' : 'insp'; const master = getMasterData(); if (data.length !== master.length) return jsonResponse({ status: 'error', msg: 'Data tidak lengkap' }); for (let i = 0; i < master.length; i++) { const critId = master[i].ID; const item = data[i]; const existing = await env.DB.prepare("SELECT id FROM data_scores WHERE year = ? AND opd_name = ? AND criteria_id = ?").bind(year, opdName, critId).first(); if (existing) { if (role === 'pm') await env.DB.prepare("UPDATE data_scores SET pm_grade = ?, pm_note = ? WHERE id = ?").bind(item.grade || '', item.note || '', existing.id).run(); else await env.DB.prepare("UPDATE data_scores SET insp_grade = ?, insp_note = ? WHERE id = ?").bind(item.grade || '', item.note || '', existing.id).run(); } else { if (role === 'pm') await env.DB.prepare("INSERT INTO data_scores (year, opd_name, criteria_id, pm_grade, pm_note) VALUES (?, ?, ?, ?, ?)").bind(year, opdName, critId, item.grade || '', item.note || '').run(); else await env.DB.prepare("INSERT INTO data_scores (year, opd_name, criteria_id, insp_grade, insp_note) VALUES (?, ?, ?, ?, ?)").bind(year, opdName, critId, item.grade || '', item.note || '').run(); } } return jsonResponse({ status: 'success', msg: 'Data berhasil disimpan.' }); }
      case 'saveQAStatus': { const { opdName, status } = params; await env.DB.prepare("INSERT OR REPLACE INTO qa_status (year, opd_name, status) VALUES (?, ?, ?)").bind(year, opdName, status).run(); return jsonResponse({ status: 'success', msg: 'Status QA berhasil disimpan.' }); }
      case 'savePrevScores': { const { opdName, scores } = params; await savePrevScores(year, opdName, scores, env); return jsonResponse({ status: 'success', msg: 'Nilai tahun sebelumnya berhasil disimpan.' }); }
      case 'getPMDataForInspector': { const { opdName } = params; const result = await getPMDataForInspectorData(year, opdName, env); const prevScores = await getPrevScores(year, opdName, env); result.prevScores = prevScores; return jsonResponse(result); }
      case 'getOPDListDetails': { const bulk = await getBulkData(year, env); return jsonResponse(bulk.map(o => ({ name: o.opd_name, pmScore: o.pmTotal, inspScore: o.inspTotal, progress: o.progress, qaStatus: o.qaApipStatus }))); }
      case 'getDashboardData': { 
        const bulk = await getBulkData(year, env);
        let totalOPD = bulk.length;
        let minPM = Infinity, minInsp = Infinity;
        let topPM = {name:'', value:0}, topInsp = {name:'', value:0};
        let qaCount = {selesai:0,proses:0,belum:0};
        let totalProgress = 0;

        if (totalOPD > 0) { 
          bulk.forEach(o => {
            const pm = parseFloat(o.pmTotal), insp = parseFloat(o.inspTotal), progress = parseFloat(o.progress);
            if (pm > 0 && pm < minPM) minPM = pm;
            if (insp > 0 && insp < minInsp) minInsp = insp;
            if (pm > topPM.value) topPM = {name: o.opd_name, value: pm};
            if (insp > topInsp.value) topInsp = {name: o.opd_name, value: insp};
            if (o.qaApipStatus === 'Selesai') qaCount.selesai++;
            else if (o.qaApipStatus === 'Proses') qaCount.proses++;
            else qaCount.belum++;
            totalProgress += progress;
          }); 
        }
        if (minPM === Infinity) minPM = 0;
        if (minInsp === Infinity) minInsp = 0;

        const respBody = { 
          year, totalOPD,
          topPM: { name: topPM.name || 'Belum ada', value: (Number(topPM.value)||0).toFixed(2) },
          topInsp: { name: topInsp.name || 'Belum ada', value: (Number(topInsp.value)||0).toFixed(2) },
          minPM: (Number(minPM)||0).toFixed(2), minInsp: (Number(minInsp)||0).toFixed(2),
          avgProgress: totalOPD > 0 ? (Number(totalProgress)/totalOPD).toFixed(0) + '%' : '0%',
          qaCount,
        }; 
        return new Response(JSON.stringify(respBody), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30' } }); 
      }
      case 'getChartData': { const bulk = await getBulkData(year, env); const labels = [], inspScores = [], pmScores = [], qaStatus = []; bulk.forEach(o => { labels.push(o.opd_name); pmScores.push(Number(o.pmTotal).toFixed(2)); inspScores.push(Number(o.inspTotal).toFixed(2)); qaStatus.push(o.qaApipStatus); }); return jsonResponse({ labels, inspScores, pmScores, qaStatus, totalOPD: bulk.length }); }
      case 'uploadEvidence': { const { opdName, criteriaId, fileName, mimeType } = params; const formData = await request.formData(); const file = formData.get('file'); if (!file) return jsonResponse({ status: 'error', msg: 'File tidak ditemukan' }); if (file.size > 10 * 1024 * 1024) return jsonResponse({ status: 'error', msg: 'File melebihi batas 10MB!' }); const safeOpd = sanitizeInput(opdName); const safeFileName = sanitizeInput(fileName); const r2Path = `sakip/${year}/${safeOpd}/${criteriaId}/${Date.now()}_${safeFileName}`; await env.EVIDENCE_BUCKET.put(r2Path, file.stream(), { httpMetadata: { contentType: mimeType || 'application/octet-stream' } }); const publicUrl = `https://pub-6825f3819d9d46089a296f5d492fab22.r2.dev/${r2Path}`; let gdriveId = null; if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) { const bytes = new Uint8Array(await file.arrayBuffer()); try { gdriveId = await uploadToGoogleDrive(env, r2Path, safeFileName, bytes, env.GOOGLE_DRIVE_FOLDER_ID); } catch (err) { console.error('Gagal upload ke Google Drive:', err.message); } } await env.DB.prepare("INSERT INTO evidence (year, opd_name, criteria_id, url, gdrive_id, file_name) VALUES (?, ?, ?, ?, ?, ?)").bind(year, safeOpd, criteriaId, publicUrl, gdriveId, safeFileName).run(); return jsonResponse({ status: 'success', url: publicUrl, gdriveId }); }
      case 'deleteEvidence': { const { opdName, criteriaId, url, gdriveId } = params; const cleanUrl = url.split('?')[0]; const marker = 'r2.dev/'; const idx = cleanUrl.indexOf(marker); if (idx !== -1) { const r2Path = decodeURIComponent(cleanUrl.substring(idx + marker.length)); await env.EVIDENCE_BUCKET.delete(r2Path); } if (gdriveId) { try { await deleteGoogleDriveFile(env, gdriveId); } catch (err) { return jsonResponse({ status: 'error', msg: 'Gagal hapus di Google Drive: ' + err.message }); } } await env.DB.prepare("DELETE FROM evidence WHERE url = ? AND year = ? AND opd_name = ? AND criteria_id = ?").bind(url, year, opdName, criteriaId).run(); return jsonResponse({ status: 'success', msg: 'File berhasil dihapus.' }); }
      case 'generateLaporanMandiri': { const { opdName } = params; const { html, aiProvider } = await generateLaporanHtml({ year, opdName, env, source: 'pm' }); const bytes = new TextEncoder().encode(html); const r2Path = `laporan/${year}/PM_${opdName}_${Date.now()}.html`; await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: 'text/html' } }); const laporanUrl = `https://pub-6825f3819d9d46089a296f5d492fab22.r2.dev/${r2Path}`; let gdocsUrl = null; if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) { try { gdocsUrl = await createGoogleDoc(env, html, `LHE_PM_${opdName}_${year}`, env.GOOGLE_DRIVE_FOLDER_ID); } catch (e) { console.error('Gagal membuat Google Docs:', e); } } return jsonResponse({ status: 'success', url: laporanUrl, gdocsUrl: gdocsUrl, aiProvider, type: 'PM' }); }
      case 'generateLaporanInspektorat': { const { opdName } = params; const { html, aiProvider } = await generateLaporanHtml({ year, opdName, env, source: 'insp' }); const bytes = new TextEncoder().encode(html); const r2Path = `laporan/${year}/INSP_${opdName}_${Date.now()}.html`; await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: 'text/html' } }); const laporanUrl = `https://pub-6825f3819d9d46089a296f5d492fab22.r2.dev/${r2Path}`; let gdocsUrl = null; if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) { try { gdocsUrl = await createGoogleDoc(env, html, `LHE_INSP_${opdName}_${year}`, env.GOOGLE_DRIVE_FOLDER_ID); } catch (e) { console.error('Gagal membuat Google Docs:', e); } } return jsonResponse({ status: 'success', url: laporanUrl, gdocsUrl: gdocsUrl, aiProvider, type: 'INSP' }); }
      default: return jsonResponse({ status: 'error', msg: 'Aksi tidak dikenal: ' + action });
    }
  } catch (err) { console.error('Error di handler:', err); return jsonResponse({ status: 'error', msg: 'Error: ' + err.message }); }
};
