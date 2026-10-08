-- database/indexes_and_views.sql
-- Run by build_database.py AFTER the data is loaded (building indexes once at
-- the end is much faster than updating them on every insert).

-- Indexes ---------------------------------------------------------------

-- Spatial lookups ("what is near this point / route") by latitude band.
CREATE INDEX idx_accidents_lat_lon       ON accidents (latitude, longitude);
CREATE INDEX idx_accidents_date          ON accidents (occurred_date);
CREATE INDEX idx_accidents_county_date   ON accidents (county_id, occurred_date);
-- The app loads walking-mode accidents with WHERE involves_pedestrian = 1.
CREATE INDEX idx_accidents_pedestrian    ON accidents (occurred_date, occurred_time) WHERE involves_pedestrian = 1;
CREATE INDEX idx_parties_accident        ON accident_parties (accident_id, party_order);
CREATE INDEX idx_streetlights_lat_lon    ON streetlights (latitude, longitude);
CREATE INDEX idx_streetlights_county     ON streetlights (county_id);
CREATE INDEX idx_stores_lat_lon          ON convenience_stores (latitude, longitude);
CREATE INDEX idx_stores_county_brand     ON convenience_stores (county_id, brand);
CREATE INDEX idx_road_alerts_occurred    ON road_alerts (occurred_at);

-- Views (readable, for TablePlus) ----------------------------------------

-- Accidents with the county name and the involved road users spelled out.
CREATE VIEW v_accidents AS
SELECT a.id,
       a.occurred_date,
       a.occurred_time,
       a.category,
       c.name AS county,
       a.location,
       a.latitude,
       a.longitude,
       a.deaths,
       a.injuries,
       rtrim(
         CASE WHEN a.involves_pedestrian THEN '行人、' ELSE '' END ||
         CASE WHEN a.involves_scooter    THEN '機車、' ELSE '' END ||
         CASE WHEN a.involves_car        THEN '汽車、' ELSE '' END ||
         CASE WHEN a.involves_bicycle    THEN '自行車、' ELSE '' END, '、') AS involved,
       a.weather,
       a.light_condition,
       a.collision_type,
       a.primary_cause,
       a.duplicate_of_id,
       s.file_path AS source_file
FROM accidents a
JOIN counties c ON c.id = a.county_id
JOIN source_files s ON s.id = a.source_file_id;

-- Exactly the records the walking score uses.
CREATE VIEW v_pedestrian_accidents AS
SELECT * FROM v_accidents
WHERE id IN (SELECT id FROM accidents WHERE involves_pedestrian = 1);

CREATE VIEW v_accidents_by_county_year AS
SELECT c.name AS county,
       substr(a.occurred_date, 1, 4) AS year,
       count(*) AS accidents,
       sum(a.category = 'A1') AS a1_fatal,
       sum(a.deaths) AS deaths,
       sum(a.injuries) AS injuries,
       sum(a.involves_pedestrian) AS with_pedestrian,
       sum(a.involves_scooter) AS with_scooter,
       sum(a.involves_car) AS with_car,
       sum(a.involves_bicycle) AS with_bicycle
FROM accidents a
JOIN counties c ON c.id = a.county_id
WHERE a.duplicate_of_id IS NULL
GROUP BY c.name, year
ORDER BY c.name, year;

CREATE VIEW v_accident_parties AS
SELECT p.accident_id,
       a.occurred_date,
       c.name AS county,
       a.location,
       p.party_order,
       p.vehicle_class,
       p.vehicle_subclass,
       p.gender,
       p.age,
       p.protective_gear,
       p.action,
       p.cause,
       p.hit_and_run
FROM accident_parties p
JOIN accidents a ON a.id = p.accident_id
JOIN counties c ON c.id = a.county_id;

CREATE VIEW v_streetlights_by_county AS
SELECT c.name AS county,
       count(s.id) AS streetlights,
       coalesce(cov.coverage_type, 'none') AS coverage,
       (SELECT count(*) FROM streetlight_coverage_cells cc WHERE cc.county_id = c.id) AS partial_cells
FROM counties c
LEFT JOIN streetlights s ON s.county_id = c.id
LEFT JOIN streetlight_coverage cov ON cov.county_id = c.id
GROUP BY c.id
ORDER BY streetlights DESC;

CREATE VIEW v_stores_by_county_brand AS
SELECT coalesce(c.name, '(unknown)') AS county,
       s.brand,
       count(*) AS stores
FROM convenience_stores s
LEFT JOIN counties c ON c.id = s.county_id
GROUP BY county, s.brand
ORDER BY county, stores DESC;

CREATE VIEW v_import_report AS
SELECT dataset, file_path, file_format, rows_read, rows_imported, rows_rejected, reject_reasons, imported_at
FROM source_files
ORDER BY dataset, file_path;

CREATE VIEW v_data_overview AS
SELECT 'accidents' AS dataset, count(*) AS records, min(occurred_date) AS first_date, max(occurred_date) AS last_date FROM accidents WHERE duplicate_of_id IS NULL
UNION ALL SELECT 'pedestrian accidents', count(*), min(occurred_date), max(occurred_date) FROM accidents WHERE involves_pedestrian = 1
UNION ALL SELECT 'accident parties', count(*), NULL, NULL FROM accident_parties
UNION ALL SELECT 'streetlights', count(*), NULL, NULL FROM streetlights
UNION ALL SELECT 'convenience stores', count(*), NULL, NULL FROM convenience_stores
UNION ALL SELECT 'road alerts', count(*), min(occurred_at), max(occurred_at) FROM road_alerts;
