-- Tabel tahun
CREATE TABLE IF NOT EXISTS years (
  year INTEGER PRIMARY KEY
);

-- Tabel OPD per tahun
CREATE TABLE IF NOT EXISTS opds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  opd_name TEXT NOT NULL,
  UNIQUE(year, opd_name)
);

-- Tabel data penilaian per item (PM dan Inspektorat)
CREATE TABLE IF NOT EXISTS data_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  opd_name TEXT NOT NULL,
  criteria_id TEXT NOT NULL,
  pm_grade TEXT DEFAULT '',
  pm_note TEXT DEFAULT '',
  insp_grade TEXT DEFAULT '',
  insp_note TEXT DEFAULT '',
  UNIQUE(year, opd_name, criteria_id)
);

-- Tabel status QA APIP
CREATE TABLE IF NOT EXISTS qa_status (
  year INTEGER NOT NULL,
  opd_name TEXT NOT NULL,
  status TEXT DEFAULT 'Belum',
  PRIMARY KEY (year, opd_name)
);

-- Tabel metadata evidence (file yang diupload)
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  opd_name TEXT NOT NULL,
  criteria_id TEXT NOT NULL,
  url TEXT NOT NULL,
  gdrive_id TEXT,
  file_name TEXT,
  upload_date TEXT DEFAULT CURRENT_TIMESTAMP
);
