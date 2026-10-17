-- database/schema.sql
--
-- Structure of database/pedestrian_safety.db (SQLite). Built from the CSVs in
-- csv/ by database/build_database.py -- never edit the .db by hand, rebuild it.
-- Open the .db file in TablePlus (or any SQLite client) to browse it.
--
-- Tables
--   counties                      22 Taiwan counties/cities (lookup)
--   source_files                  every input file + how many rows it gave / lost
--   accidents                     one row per A1/A2 traffic accident, 2021-2025
--   accident_parties              one row per party (person/vehicle) in an accident
--   streetlights                  one row per streetlight
--   streetlight_coverage          which counties have streetlight data (full/partial)
--   streetlight_coverage_cells    for partial counties: grid cells that do have data
--   convenience_stores            one row per convenience store
--   road_alerts                   freeway construction / incident notices (reference only)
--   metadata                      key/value facts about this build
-- Views (v_*) join these into readable summaries; see the bottom of this file.

PRAGMA foreign_keys = ON;

CREATE TABLE metadata (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE counties (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE            -- always written with 臺 (not 台)
);

CREATE TABLE source_files (
  id             INTEGER PRIMARY KEY,
  dataset        TEXT NOT NULL CHECK (dataset IN ('accidents', 'streetlights', 'convenience_stores', 'road_alerts')),
  file_path      TEXT NOT NULL UNIQUE, -- relative to the project root
  file_format    TEXT,                 -- which reader parsed it
  file_bytes     INTEGER,
  rows_read      INTEGER NOT NULL DEFAULT 0,
  rows_imported  INTEGER NOT NULL DEFAULT 0,
  rows_rejected  INTEGER NOT NULL DEFAULT 0,
  reject_reasons TEXT,                 -- JSON object: reason -> count
  imported_at    TEXT NOT NULL
);

-- One row per accident. Built with exactly the same rules as
-- pedestrianSafety/data/build_accidents_all_modes.py (same files, same
-- old/new format handling, same per-county coordinate check, same A1/A2
-- de-duplication), plus the descriptive columns the 111+ CSVs carry.
CREATE TABLE accidents (
  id                  INTEGER PRIMARY KEY,
  occurred_date       TEXT NOT NULL CHECK (occurred_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  occurred_time       TEXT,             -- HHMMSS
  category            TEXT NOT NULL CHECK (category IN ('A1', 'A2')),  -- A1 = death within 24h, A2 = injury
  county_id           INTEGER NOT NULL REFERENCES counties(id),
  location            TEXT NOT NULL,    -- 發生地點
  latitude            REAL NOT NULL CHECK (latitude BETWEEN 21.0 AND 27.0),
  longitude           REAL NOT NULL CHECK (longitude BETWEEN 118.0 AND 123.0),
  deaths              INTEGER NOT NULL DEFAULT 0 CHECK (deaths >= 0),
  injuries            INTEGER NOT NULL DEFAULT 0 CHECK (injuries >= 0),
  severity_text       TEXT,             -- original 死亡受傷人數, e.g. 死亡0;受傷1
  involves_pedestrian INTEGER NOT NULL CHECK (involves_pedestrian IN (0, 1)),
  involves_scooter    INTEGER NOT NULL CHECK (involves_scooter IN (0, 1)),
  involves_car        INTEGER NOT NULL CHECK (involves_car IN (0, 1)),
  involves_bicycle    INTEGER NOT NULL CHECK (involves_bicycle IN (0, 1)),
  -- Descriptive fields (NULL for 2021 / 110年度 files, which don't have them)
  police_unit         TEXT,             -- 處理單位名稱警局層
  weather             TEXT,             -- 天候名稱
  light_condition     TEXT,             -- 光線名稱
  road_class          TEXT,             -- 道路類別-第1當事者-名稱
  speed_limit         INTEGER,          -- 速限-第1當事者
  road_layout         TEXT,             -- 道路型態大類別名稱 / 子類別
  collision_type      TEXT,             -- 事故類型及型態大類別名稱 / 子類別
  primary_cause       TEXT,             -- 肇因研判子類別名稱-主要
  -- Normally NULL. The government exports sometimes list one accident twice
  -- (e.g. in both the A1 and the A2 file). Duplicates are dropped, except
  -- when the earlier copy has no pedestrian party and this one does: the
  -- walking score has always counted that copy, so it is kept, pointing at
  -- the copy it duplicates. Scooter/car scoring skips rows where this is set.
  duplicate_of_id     INTEGER REFERENCES accidents(id),
  source_file_id      INTEGER NOT NULL REFERENCES source_files(id)
);

CREATE TABLE accident_parties (
  id               INTEGER PRIMARY KEY,
  accident_id      INTEGER NOT NULL REFERENCES accidents(id) ON DELETE CASCADE,
  party_order      INTEGER NOT NULL,   -- 當事者順位 (1 = first party)
  vehicle_class    TEXT,               -- 大類別, e.g. 人 / 機車 / 小客車 / 慢車
  vehicle_subclass TEXT,               -- 子類別, e.g. 行人 / 普通重型 / 自用
  gender           TEXT,               -- NULL for 110年度
  age              INTEGER,            -- NULL for 110年度 or when unknown
  protective_gear  TEXT,
  phone_use        TEXT,
  action           TEXT,               -- 當事者行動狀態子類別名稱
  cause            TEXT,               -- 肇因研判子類別名稱-個別
  hit_and_run      INTEGER CHECK (hit_and_run IN (0, 1))
);

CREATE TABLE streetlights (
  id             INTEGER PRIMARY KEY,
  county_id      INTEGER NOT NULL REFERENCES counties(id),
  lamp_id        TEXT,
  latitude       REAL NOT NULL CHECK (latitude BETWEEN 21.8 AND 26.5),
  longitude      REAL NOT NULL CHECK (longitude BETWEEN 118.0 AND 122.1),
  source_file_id INTEGER NOT NULL REFERENCES source_files(id)
);

-- 'full' = the whole county is covered; 'partial' = only the cells listed in
-- streetlight_coverage_cells. Counties not listed here have NO streetlight
-- data, and the app shows "no data" there instead of scoring them as dark.
CREATE TABLE streetlight_coverage (
  county_id     INTEGER PRIMARY KEY REFERENCES counties(id),
  coverage_type TEXT NOT NULL CHECK (coverage_type IN ('full', 'partial')),
  lamp_count    INTEGER NOT NULL
);

-- cell = (floor(lat / d), floor(lon / d)) with d = metadata 'streetlight_partial_cell_degrees'
CREATE TABLE streetlight_coverage_cells (
  county_id INTEGER NOT NULL REFERENCES streetlight_coverage(county_id),
  cell_i    INTEGER NOT NULL,
  cell_j    INTEGER NOT NULL,
  PRIMARY KEY (county_id, cell_i, cell_j)
) WITHOUT ROWID;

CREATE TABLE convenience_stores (
  id        INTEGER PRIMARY KEY,
  brand     TEXT NOT NULL,             -- 7-Eleven / FamilyMart / Hi-Life / OK Mart (/ PX Mart)
  name      TEXT,
  address   TEXT,
  county_id INTEGER REFERENCES counties(id),
  district  TEXT,
  latitude  REAL NOT NULL CHECK (latitude BETWEEN 21.8 AND 26.5),
  longitude REAL NOT NULL CHECK (longitude BETWEEN 118.0 AND 122.1)
);

-- csv/道路施工、災害路段提醒.csv. Imported for reference / future use; the
-- safety score does not use it.
CREATE TABLE road_alerts (
  id               INTEGER PRIMARY KEY,
  alert_type       TEXT,               -- 類別
  title            TEXT,               -- 公告名稱
  content          TEXT,               -- 公告內容
  affected_section TEXT,               -- 影響區段
  occurred_at      TEXT,               -- 發生時間
  control_start    TEXT,               -- 管制開始時間
  control_end      TEXT,               -- 管制結束時間
  note             TEXT,               -- 備註
  source_file_id   INTEGER NOT NULL REFERENCES source_files(id)
);
