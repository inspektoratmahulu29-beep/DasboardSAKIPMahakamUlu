import { getMasterData } from './sakipMasterData.js';

const DB_FILE_NAME = 'SAKIP_DB.json';

// ============ GOOGLE DRIVE INTEGRATION (OAUTH - REFRESH TOKEN) ============
async function getGoogleAccessToken(env) {
  const { GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN } = env;
  if (!GOOGLE_DRIVE_CLIENT_ID || !GOOGLE_DRIVE_CLIENT_SECRET || !GOOGLE_DRIVE_REFRESH_TOKEN) {
    throw new Error('Google Drive credentials not configured');
  }
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_DRIVE_CLIENT_ID,
      client_secret: GOOGLE_DRIVE_CLIENT_SECRET,
      refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) {
    throw new Error('Failed to get Google Drive access token: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

async function createFolder(accessToken, parentId, folderName) {
  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Gagal membuat folder: ' + JSON.stringify(data));
  return data.id;
}

async function getOrCreateFolder(accessToken, parentId, folderName) {
  const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json();
  if (data.files && data.files.length > 0) return data.files[0].id;
  return await createFolder(accessToken, parentId, folderName);
}

async function uploadToGoogleDrive(env, filePath, fileName, bytes, rootFolderId) {
  const accessToken = await getGoogleAccessToken(env);
  const pathSegments = filePath.split('/');
  pathSegments.pop(); // hapus nama file
  let currentFolderId = rootFolderId;
  for (const folderName of pathSegments) {
    if (!folderName) continue;
    currentFolderId = await getOrCreateFolder(accessToken, currentFolderId, folderName);
  }
  const metadata = { name: fileName, parents: [currentFolderId] };
  const initResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': bytes.length.toString()
    },
    body: JSON.stringify(metadata)
  });
  if (!initResponse.ok) {
    const errText = await initResponse.text();
    throw new Error('Gagal inisialisasi upload: ' + errText);
  }
  const location = initResponse.headers.get('Location');
  if (!location) throw new Error('Tidak ada URL upload dari Google Drive');
  const uploadResponse = await fetch(location, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length.toString() },
    body: bytes
  });
  const result = await uploadResponse.json();
  if (!uploadResponse.ok) throw new Error('Gagal upload file ke Google Drive: ' + JSON.stringify(result));
  return result.id;
}

async function deleteGoogleDriveFile(env, fileId) {
  const accessToken = await getGoogleAccessToken(env);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok && response.status !== 404) {
    const errText = await response.text();
    throw new Error('Gagal hapus file di Google Drive: ' + errText);
  }
}
// ============ END GOOGLE DRIVE INTEGRATION ============

// ====== FUNGSI HELPER: Ambil Data Gabungan untuk Kertas Kerja ======
async function getPMDataForInspectorData(year, opdName, env) {
  const master = getMasterData();
  const dataScores = await env.DB.prepare("SELECT * FROM data_scores WHERE year = ? AND opd_name = ?").bind(year, opdName).all();
  const scoreMap = {};
  dataScores.results.forEach(row => {
    scoreMap[row.criteria_id] = row;
  });
  const qaRow = await env.DB.prepare("SELECT status FROM qa_status WHERE year = ? AND opd_name = ?").bind(year, opdName).first();
  const qaStatus = qaRow ? qaRow.status : 'Belum';
  const evidenceRows = await env.DB.prepare("SELECT * FROM evidence WHERE year = ? AND opd_name = ?").bind(year, opdName).all();
  const evMap = {};
  evidenceRows.results.forEach(row => {
    if (!evMap[row.criteria_id]) evMap[row.criteria_id] = [];
    evMap[row.criteria_id].push({ url: row.url, fileName: row.file_name, date: row.upload_date });
  });

  return master.map(row => {
    const sc = scoreMap[row.ID] || {};
    return {
      ...row,
      pmGrade: sc.pm_grade || "",
      pmNote: sc.pm_note || "",
      inspGrade: sc.insp_grade || "",
      inspNote: sc.insp_note || "",
      evUrls: evMap[row.ID] || [],
      qaApipStatus: qaStatus
    };
  });
}

export const onRequest = async ({ request, env }) => {
  const ACCESS_PASSWORD = env.ACCESS_PASSWORD;
  const INSP_PASSWORD = env.INSP_PASSWORD;
  const DELETE_PASSWORD = env.DELETE_PASSWORD;
  const url = new URL(request.url);
  let params = {};
  let action = url.searchParams.get('action') || '';

  if (request.method === 'POST') {
    try {
      params = await request.json();
      if (!action && params.action) action = params.action;
    } catch (e) {
      return new Response(JSON.stringify({ status: 'error', msg: 'Invalid JSON body' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  } else {
    url.searchParams.forEach((value, key) => { params[key] = value; });
  }

  const year = params.year || '2026';

  try {
    switch (action) {
      // ====== VERIFIKASI PASSWORD ======
      case 'verifyPasswordPM': {
        const valid = params.password === ACCESS_PASSWORD;
        return new Response(JSON.stringify({ status: valid ? 'success' : 'error', msg: valid ? 'Password benar' : 'Password salah' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      case 'verifyPasswordInsp': {
        const valid = params.password === INSP_PASSWORD;
        return new Response(JSON.stringify({ status: valid ? 'success' : 'error', msg: valid ? 'Password benar' : 'Password salah' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      case 'verifyPasswordDeleteYear':
      case 'verifyPasswordDeleteOPD': {
        const valid = params.password === DELETE_PASSWORD;
        return new Response(JSON.stringify({ status: valid ? 'success' : 'error', msg: valid ? 'Password benar' : 'Password salah' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ====== MANAJEMEN TAHUN ======
      case 'getYears': {
        const { results } = await env.DB.prepare("SELECT year FROM years ORDER BY year DESC").all();
        const years = results.map(r => r.year);
        if (!years.includes(2026)) years.push(2026);
        return new Response(JSON.stringify([...new Set(years)].sort((a,b) => b - a)), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      case 'addYear': {
        await env.DB.prepare("INSERT OR IGNORE INTO years (year) VALUES (?)").bind(params.year).run();
        return new Response(JSON.stringify({ status: 'success', msg: 'Tahun ' + params.year + ' berhasil ditambahkan.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      case 'deleteYear': {
        await env.DB.prepare("DELETE FROM data_scores WHERE year = ?").bind(params.year).run();
        await env.DB.prepare("DELETE FROM opds WHERE year = ?").bind(params.year).run();
        await env.DB.prepare("DELETE FROM qa_status WHERE year = ?").bind(params.year).run();
        await env.DB.prepare("DELETE FROM evidence WHERE year = ?").bind(params.year).run();
        await env.DB.prepare("DELETE FROM years WHERE year = ?").bind(params.year).run();
        return new Response(JSON.stringify({ status: 'success', msg: 'Tahun ' + params.year + ' berhasil dihapus.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ====== MANAJEMEN OPD ======
      case 'getAllOPDs': {
        const { results } = await env.DB.prepare("SELECT opd_name FROM opds WHERE year = ? ORDER BY opd_name").bind(year).all();
        return new Response(JSON.stringify(results.map(r => r.opd_name)), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      case 'addOPD': {
        const opdName = params.opdName;
        if (!opdName) return new Response(JSON.stringify({ status: 'error', msg: 'Nama OPD kosong' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        const existing = await env.DB.prepare("SELECT id FROM opds WHERE year = ? AND opd_name = ?").bind(year, opdName).first();
        if (existing) return new Response(JSON.stringify({ status: 'error', msg: 'OPD sudah ada!' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        await env.DB.prepare("INSERT INTO opds (year, opd_name) VALUES (?, ?)").bind(year, opdName).run();
        return new Response(JSON.stringify({ status: 'success', msg: 'OPD ' + opdName + ' berhasil ditambahkan.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      case 'deleteOPD': {
        const opdName = params.opdName;
        await env.DB.prepare("DELETE FROM data_scores WHERE year = ? AND opd_name = ?").bind(year, opdName).run();
        await env.DB.prepare("DELETE FROM opds WHERE year = ? AND opd_name = ?").bind(year, opdName).run();
        await env.DB.prepare("DELETE FROM qa_status WHERE year = ? AND opd_name = ?").bind(year, opdName).run();
        await env.DB.prepare("DELETE FROM evidence WHERE year = ? AND opd_name = ?").bind(year, opdName).run();
        return new Response(JSON.stringify({ status: 'success', msg: 'OPD ' + opdName + ' berhasil dihapus.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ====== DATA MASTER ======
      case 'getMasterData': {
        return new Response(JSON.stringify(getMasterData()), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ====== SIMPAN DATA PM / INSPEKTORAT ======
      case 'savePMData':
      case 'saveInspData': {
        const { opdName, data } = params;
        const role = action === 'savePMData' ? 'pm' : 'insp';
        const master = getMasterData();
        if (data.length !== master.length) return new Response(JSON.stringify({ status: 'error', msg: 'Data tidak lengkap' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        for (let i = 0; i < master.length; i++) {
          const critId = master[i].ID;
          const item = data[i];
          const existing = await env.DB.prepare("SELECT id FROM data_scores WHERE year = ? AND opd_name = ? AND criteria_id = ?").bind(year, opdName, critId).first();
          if (existing) {
            if (role === 'pm') {
              await env.DB.prepare("UPDATE data_scores SET pm_grade = ?, pm_note = ? WHERE id = ?").bind(item.grade || '', item.note || '', existing.id).run();
            } else {
              await env.DB.prepare("UPDATE data_scores SET insp_grade = ?, insp_note = ? WHERE id = ?").bind(item.grade || '', item.note || '', existing.id).run();
            }
          } else {
            if (role === 'pm') {
              await env.DB.prepare("INSERT INTO data_scores (year, opd_name, criteria_id, pm_grade, pm_note) VALUES (?, ?, ?, ?, ?)").bind(year, opdName, critId, item.grade || '', item.note || '').run();
            } else {
              await env.DB.prepare("INSERT INTO data_scores (year, opd_name, criteria_id, insp_grade, insp_note) VALUES (?, ?, ?, ?, ?)").bind(year, opdName, critId, item.grade || '', item.note || '').run();
            }
          }
        }
        return new Response(JSON.stringify({ status: 'success', msg: 'Data berhasil disimpan.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ====== SIMPAN STATUS QA ======
      case 'saveQAStatus': {
        const { opdName, status } = params;
        await env.DB.prepare("INSERT OR REPLACE INTO qa_status (year, opd_name, status) VALUES (?, ?, ?)").bind(year, opdName, status).run();
        return new Response(JSON.stringify({ status: 'success', msg: 'Status QA berhasil disimpan.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ====== AMBIL DATA GABUNGAN UNTUK KERTAS KERJA ======
      case 'getPMDataForInspector': {
        const { opdName } = params;
        const result = await getPMDataForInspectorData(year, opdName, env);
        return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ====== DASHBOARD: DAFTAR OPD DETAIL ======
      case 'getOPDListDetails': {
        const opds = await env.DB.prepare("SELECT opd_name FROM opds WHERE year = ? ORDER BY opd_name").bind(year).all();
        const result = [];
        for (const opd of opds.results) {
          const data = await getPMDataForInspectorData(year, opd.opd_name, env);
          let pmTotal = 0, inspTotal = 0, qaStatus = 'Belum';
          data.forEach(row => {
            pmTotal += row.RuleMap[row.pmGrade] || 0;
            inspTotal += row.RuleMap[row.inspGrade] || 0;
            if (row.qaApipStatus) qaStatus = row.qaApipStatus;
          });
          const totalBobot = data.reduce((sum, row) => sum + (row.Bobot || 0), 0);
          const progress = totalBobot > 0 ? ((pmTotal / totalBobot) * 100).toFixed(0) + '%' : '0%';
          result.push({ name: opd.opd_name, pmScore: pmTotal.toFixed(2), inspScore: inspTotal.toFixed(2), progress, qaStatus });
        }
        return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ====== DASHBOARD: DATA UTAMA ======
      case 'getDashboardData': {
        const opds = await env.DB.prepare("SELECT opd_name FROM opds WHERE year = ?").bind(year).all();
        if (opds.results.length === 0) return new Response(JSON.stringify({ year, totalOPD: 0, topPM: {name:'Belum ada',value:'0.00'}, topInsp: {name:'Belum ada',value:'0.00'}, qaCount:{selesai:0,proses:0,belum:0}, evidenceLengkap:'0%', avgProgress:'0%', minPM:'0.00', minInsp:'0.00' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        let totalOPD = opds.results.length;
        let minPM = Infinity, minInsp = Infinity;
        let topPM = {name:'', value:-1}, topInsp = {name:'', value:-1};
        let qaCount = {selesai:0,proses:0,belum:0};
        let evidenceLengkapCount = 0;
        let totalProgress = 0;
        for (const opd of opds.results) {
          const data = await getPMDataForInspectorData(year, opd.opd_name, env);
          let pmScore = 0, inspScore = 0, qaStatus = 'Belum';
          data.forEach(row => {
            pmScore += row.RuleMap[row.pmGrade] || 0;
            inspScore += row.RuleMap[row.inspGrade] || 0;
            if (row.qaApipStatus) qaStatus = row.qaApipStatus;
          });
          const totalBobot = data.reduce((sum, row) => sum + (row.Bobot || 0), 0);
          const progress = totalBobot > 0 ? (pmScore / totalBobot * 100) : 0;
          if (pmScore > 0 && pmScore < minPM) minPM = pmScore;
          if (inspScore > 0 && inspScore < minInsp) minInsp = inspScore;
          if (pmScore > topPM.value) topPM = {name: opd.opd_name, value: pmScore};
          if (inspScore > topInsp.value) topInsp = {name: opd.opd_name, value: inspScore};
          if (qaStatus === 'Selesai') qaCount.selesai++;
          else if (qaStatus === 'Proses') qaCount.proses++;
          else qaCount.belum++;
          totalProgress += progress;
          if (pmScore > 0) evidenceLengkapCount++;
        }
        if (minPM === Infinity) minPM = 0;
        if (minInsp === Infinity) minInsp = 0;
        return new Response(JSON.stringify({
          year, totalOPD,
          topPM: { name: topPM.name || 'Belum ada', value: (Number(topPM.value)||0).toFixed(2) },
          topInsp: { name: topInsp.name || 'Belum ada', value: (Number(topInsp.value)||0).toFixed(2) },
          minPM: (Number(minPM)||0).toFixed(2),
          minInsp: (Number(minInsp)||0).toFixed(2),
          avgProgress: (Number(totalProgress)/totalOPD).toFixed(0) + '%',
          qaCount,
          evidenceLengkap: (evidenceLengkapCount/totalOPD*100).toFixed(0) + '%'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ====== DASHBOARD: DATA CHART ======
      case 'getChartData': {
        const opds = await env.DB.prepare("SELECT opd_name FROM opds WHERE year = ?").bind(year).all();
        const labels = [], inspScores = [], pmScores = [], qaStatus = [];
        for (const opd of opds.results) {
          const data = await getPMDataForInspectorData(year, opd.opd_name, env);
          let pmTotal = 0, inspTotal = 0, status = 'Belum';
          data.forEach(row => {
            pmTotal += row.RuleMap[row.pmGrade] || 0;
            inspTotal += row.RuleMap[row.inspGrade] || 0;
            if (row.qaApipStatus) status = row.qaApipStatus;
          });
          labels.push(opd.opd_name);
          pmScores.push(Number(pmTotal).toFixed(2));
          inspScores.push(Number(inspTotal).toFixed(2));
          qaStatus.push(status);
        }
        return new Response(JSON.stringify({ labels, inspScores, pmScores, qaStatus, totalOPD: opds.results.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ====== UPLOAD EVIDENCE ======
      case 'uploadEvidence': {
        const { base64Data, opdName, criteriaId, fileName, mimeType } = params;
        const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        const r2Path = `sakip/${year}/${opdName}/${criteriaId}/${Date.now()}_${fileName}`;
        await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: mimeType || 'application/octet-stream' } });
        const publicUrl = `https://pub-8e4e0075c2e4428e95f6455b2e2b9826.r2.dev/${r2Path}`; // Ganti dengan domain R2 publik Anda

        let gdriveId = null;
        if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) {
          try {
            gdriveId = await uploadToGoogleDrive(env, r2Path, fileName, bytes, env.GOOGLE_DRIVE_FOLDER_ID);
          } catch (err) {
            console.error('Gagal upload ke Google Drive:', err.message);
          }
        }

        await env.DB.prepare("INSERT INTO evidence (year, opd_name, criteria_id, url, gdrive_id, file_name) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(year, opdName, criteriaId, publicUrl, gdriveId, fileName).run();

        return new Response(JSON.stringify({ status: 'success', url: publicUrl, gdriveId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ====== HAPUS EVIDENCE ======
      case 'deleteEvidence': {
        const { opdName, criteriaId, url, gdriveId } = params;
        const cleanUrl = url.split('?')[0];
        const marker = 'r2.dev/';
        const idx = cleanUrl.indexOf(marker);
        if (idx !== -1) {
          const r2Path = decodeURIComponent(cleanUrl.substring(idx + marker.length));
          await env.EVIDENCE_BUCKET.delete(r2Path);
        }
        if (gdriveId) {
          try {
            await deleteGoogleDriveFile(env, gdriveId);
          } catch (err) {
            return new Response(JSON.stringify({ status: 'error', msg: 'Gagal hapus di Google Drive: ' + err.message }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
        }
        await env.DB.prepare("DELETE FROM evidence WHERE url = ? AND year = ? AND opd_name = ? AND criteria_id = ?").bind(url, year, opdName, criteriaId).run();
        return new Response(JSON.stringify({ status: 'success', msg: 'File berhasil dihapus.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ====== GENERATE LAPORAN (HTML lengkap) ======
      case 'generateLaporanMandiri': {
        const { opdName } = params;
        const data = await getPMDataForInspectorData(year, opdName, env);
        // Hitung nilai per komponen
        const komponenList = ["PERENCANAAN KINERJA", "PENGUKURAN KINERJA", "PELAPORAN KINERJA", "EVALUASI AKUNTABILITAS KINERJA INTERNAL"];
        const maxBobot = { "PERENCANAAN KINERJA": 0, "PENGUKURAN KINERJA": 0, "PELAPORAN KINERJA": 0, "EVALUASI AKUNTABILITAS KINERJA INTERNAL": 0 };
        const nilaiKomponen = { "PERENCANAAN KINERJA": 0, "PENGUKURAN KINERJA": 0, "PELAPORAN KINERJA": 0, "EVALUASI AKUNTABILITAS KINERJA INTERNAL": 0 };
        const catatanPerKomponen = { "PERENCANAAN KINERJA": [], "PENGUKURAN KINERJA": [], "PELAPORAN KINERJA": [], "EVALUASI AKUNTABILITAS KINERJA INTERNAL": [] };
        const belumTerpenuhi = { "PERENCANAAN KINERJA": [], "PENGUKURAN KINERJA": [], "PELAPORAN KINERJA": [], "EVALUASI AKUNTABILITAS KINERJA INTERNAL": [] };

        data.forEach(row => {
          const komp = row.Komponen;
          const bobot = row.Bobot || 0;
          const nilai = row.RuleMap[row.pmGrade] || 0;
          maxBobot[komp] += bobot;
          nilaiKomponen[komp] += nilai;
          if (!row.pmGrade || row.pmGrade === "") {
            belumTerpenuhi[komp].push(row.ID + " - " + row.Kriteria);
          }
          if (row.pmNote && row.pmNote.trim() !== "") {
            catatanPerKomponen[komp].push(row.ID + " - " + row.Kriteria + " : " + row.pmNote);
          }
        });

        let totalNilai = 0, totalMax = 0;
        komponenList.forEach(k => {
          totalNilai += nilaiKomponen[k];
          totalMax += maxBobot[k];
        });
        const persentaseTotal = (totalNilai / totalMax * 100).toFixed(2);
        const predikat = totalNilai > 90 ? "AA" : totalNilai > 80 ? "A" : totalNilai > 70 ? "BB" : totalNilai > 60 ? "B" : totalNilai > 50 ? "CC" : totalNilai >= 30 ? "C" : "D";

        // Buat HTML laporan
        let html = `<html><head><title>LHE PM SAKIP ${opdName} TA ${year}</title></head><body style="font-family:Times New Roman; font-size:12pt; line-height:1.5; margin:2cm;">`;
        html += `<div style="text-align:center;"><h3>PEMERINTAH KABUPATEN MAHAKAM ULU</h3><h4>${opdName}</h4><p>Jalan Gunung Belareq Gg. Dunhil RT. VII Kampung Ujoh Bilang Kecamatan Long Bagun</p><h5>UJOH BILANG</h5><hr></div>`;
        html += `<div style="text-align:center;"><h2>LAPORAN HASIL EVALUASI PENILAIAN MANDIRI (LHE PM)</h2><h3>AKUNTABILITAS KINERJA INSTANSI PEMERINTAH (AKIP)</h3><h4>${opdName} KABUPATEN MAHAKAM ULU ${year}</h4><p>Nomor: ....../..../LHE-PM/${opdName}/2026</p></div><br><br>`;
        html += `<h4>I. PENDAHULUAN</h4><p>Laporan Hasil Evaluasi Penilaian Mandiri (LHE PM) Akuntabilitas Kinerja Instansi Pemerintah (AKIP) ${opdName} Kabupaten Mahakam Ulu Tahun Anggaran ${year} disusun sebagai potret kondisi akuntabilitas kinerja perangkat daerah berdasarkan hasil telaah atas dokumen dan catatan evaluasi SAKIP yang tersedia. Dalam penyusunan laporan ini, hasil evaluasi Inspektorat Kabupaten Mahakam Ulu digunakan sebagai bahan utama untuk memetakan capaian, kekuatan, kelemahan, dan prioritas perbaikan implementasi SAKIP di lingkungan ${opdName}.</p>`;
        html += `<p>Evaluasi difokuskan pada ketersediaan bukti dukung, kualitas implementasi, serta pemanfaatan SAKIP pada empat komponen utama sesuai kerangka evaluasi dalam Peraturan Menteri Pendayagunaan Aparatur Negara dan Reformasi Birokrasi Nomor 88 Tahun 2021, Peraturan Bupati Mahakam Ulu Nomor 1 Tahun 2026 tentang Evaluasi Akuntabilitas Kinerja Instansi Pemerintah yaitu Perencanaan Kinerja, Pengukuran Kinerja, Pelaporan Kinerja, dan Evaluasi Akuntabilitas Kinerja Internal.</p>`;
        html += `<h4>II. GAMBARAN UMUM HASIL EVALUASI</h4><p>Secara keseluruhan, ${opdName} memperoleh nilai Penilaian Mandiri/hasil evaluasi sebesar ${totalNilai.toFixed(2)} dengan predikat ${predikat}. Nilai tersebut merupakan hasil akumulasi empat komponen SAKIP.</p>`;
        // Tabel ringkasan
        html += `<table border="1" style="border-collapse:collapse; width:100%; margin-top:10px;"><tr style="background:#e8e8e8;"><th>Komponen</th><th>Bobot</th><th>Nilai</th><th>Persentase</th><th>Catatan Umum</th></tr>`;
        komponenList.forEach(k => {
          const pct = (nilaiKomponen[k] / maxBobot[k] * 100).toFixed(2) + "%";
          const catatan = catatanPerKomponen[k].length > 0 ? "Perlu penguatan" : "Sudah baik";
          html += `<tr><td>${k}</td><td>${maxBobot[k]}%</td><td>${nilaiKomponen[k].toFixed(2)}</td><td>${pct}</td><td>${catatan}</td></tr>`;
        });
        html += `<tr style="background:#f0f0f0;"><td>TOTAL</td><td>100%</td><td>${totalNilai.toFixed(2)}</td><td>${persentaseTotal}%</td><td>Predikat ${predikat}</td></tr></table>`;
        html += `<h4>III. ANALISIS PER KOMPONEN</h4>`;
        komponenList.forEach((k, idx) => {
          html += `<h5>${idx+1}. ${k} — nilai ${nilaiKomponen[k].toFixed(2)} dari maksimal ${maxBobot[k].toFixed(2)}</h5>`;
          const persentaseKomponen = (nilaiKomponen[k] / maxBobot[k] * 100).toFixed(2);
          html += `<p>Komponen ini memperoleh nilai ${nilaiKomponen[k].toFixed(2)} dari maksimal ${maxBobot[k].toFixed(2)}. Persentase capaian: ${persentaseKomponen}%.</p>`;
          if (belumTerpenuhi[k].length > 0) {
            html += `<p><b>Kriteria yang belum terpenuhi:</b></p><ul>`;
            belumTerpenuhi[k].forEach(item => html += `<li>${item}</li>`);
            html += `</ul>`;
          }
          if (catatanPerKomponen[k].length > 0) {
            html += `<p><b>Catatan kekurangan dan temuan:</b></p><ul>`;
            catatanPerKomponen[k].forEach(item => html += `<li>${item}</li>`);
            html += `</ul>`;
          } else {
            html += `<p>Tidak ada catatan khusus pada komponen ini.</p>`;
          }
        });
        // Rekomendasi
        const rekomendasi = [];
        if (nilaiKomponen["PERENCANAAN KINERJA"] / maxBobot["PERENCANAAN KINERJA"] < 0.7) {
          rekomendasi.push("Melakukan reviu dan penyempurnaan Pohon Kinerja serta cascading agar hubungan sebab-akibat antarindikator terlihat jelas.");
          rekomendasi.push("Menetapkan dan memperbaiki indikator kinerja utama berbasis outcome yang memenuhi prinsip SMART.");
          rekomendasi.push("Menyusun Manual Indikator/Profil Indikator untuk seluruh IKU.");
        }
        if (nilaiKomponen["PENGUKURAN KINERJA"] / maxBobot["PENGUKURAN KINERJA"] < 0.7) {
          rekomendasi.push("Melaksanakan pengukuran serta rapat evaluasi kinerja secara berkala, sekurang-kurangnya setiap triwulan.");
          rekomendasi.push("Menyelaraskan Rencana Aksi dengan postur DPA/DPA Perubahan.");
        }
        if (nilaiKomponen["PELAPORAN KINERJA"] / maxBobot["PELAPORAN KINERJA"] < 0.7) {
          rekomendasi.push("Melengkapi LKjIP dengan reviu internal yang resmi dan berjenjang.");
        }
        if (nilaiKomponen["EVALUASI AKUNTABILITAS KINERJA INTERNAL"] / maxBobot["EVALUASI AKUNTABILITAS KINERJA INTERNAL"] < 0.7) {
          rekomendasi.push("Membentuk secara resmi Tim Evaluator Mandiri melalui Surat Tugas.");
        }
        if (rekomendasi.length === 0) rekomendasi.push("Pertahankan capaian yang sudah baik dan tingkatkan kualitas implementasi SAKIP secara berkelanjutan.");
        html += `<h4>IV. REKOMENDASI PERBAIKAN</h4><ul>`;
        rekomendasi.forEach(r => html += `<li>${r}</li>`);
        html += `</ul>`;
        html += `<h4>V. PENUTUP</h4><p>Hasil Penilaian Mandiri/hasil evaluasi SAKIP ${opdName} Kabupaten Mahakam Ulu Tahun Anggaran ${year} menunjukkan nilai ${totalNilai.toFixed(2)} dengan predikat ${predikat}. Hasil ini menunjukkan bahwa fondasi SAKIP telah tersedia dan terdapat beberapa praktik yang sudah berjalan, namun kualitas perencanaan, pengukuran, pelaporan, serta evaluasi internal masih perlu diperkuat agar SAKIP semakin berfungsi sebagai instrumen manajemen kinerja yang mendorong pencapaian outcome, efektivitas program, dan efisiensi anggaran.</p>`;
        html += `<br><br><div style="text-align:right;"><p>Ujoh Bilang, ${new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })}</p><p>Kepala ${opdName}</p><br><br><p>_______________________</p><p>Nama Lengkap</p><p>NIP. ............................</p></div>`;
        html += `</body></html>`;

        const bytes = new TextEncoder().encode(html);
        const r2Path = `laporan/${year}/${opdName}_${Date.now()}.html`;
        await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: 'text/html' } });
        const laporanUrl = `https://pub-8e4e0075c2e4428e95f6455b2e2b9826.r2.dev/${r2Path}`;
        if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID) {
          try { await uploadToGoogleDrive(env, r2Path, `LHE_${opdName}_${year}.html`, bytes, env.GOOGLE_DRIVE_FOLDER_ID); } catch (e) {}
        }
        return new Response(JSON.stringify({ status: 'success', url: laporanUrl }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      default:
        return new Response(JSON.stringify({ status: 'error', msg: 'Aksi tidak dikenal: ' + action }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  } catch (err) {
    return new Response(JSON.stringify({ status: 'error', msg: 'Error: ' + err.message }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
};
