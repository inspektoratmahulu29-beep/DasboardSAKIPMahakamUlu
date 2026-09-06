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

        const result = master.map(row => {
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
        return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

      // ====== GENERATE LAPORAN (HTML) ======
      case 'generateLaporanMandiri': {
        const { opdName } = params;
        const data = await getPMDataForInspector(year, opdName);
        // Hitung nilai dan susun HTML laporan (sama seperti di Code.gs)
        // Untuk singkat, kita buat HTML sederhana
        let html = `<html><body><h1>Laporan Hasil Evaluasi Mandiri SAKIP ${opdName} TA ${year}</h1>`;
        // ... lengkapi sesuai format yang diinginkan
        html += `</body></html>`;
        const bytes = new TextEncoder().encode(html);
        const r2Path = `laporan/${year}/${opdName}_${Date.now()}.html`;
        await env.EVIDENCE_BUCKET.put(r2Path, bytes, { httpMetadata: { contentType: 'text/html' } });
        const laporanUrl = `https://pub-8e4e0075c2e4428e95f6455b2e2b9826.r2.dev/${r2Path}`;
        // Juga upload ke Google Drive sebagai backup
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
