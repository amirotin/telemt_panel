CREATE TABLE metric_points_v3 (
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    tier TEXT NOT NULL CHECK(tier IN ('raw', '1m', '15m')),
    ts INTEGER NOT NULL,
    value REAL NOT NULL,
    max REAL NOT NULL,
    samples INTEGER NOT NULL CHECK(samples > 0),
    last_ts INTEGER NOT NULL,
    PRIMARY KEY(name, tier, ts)
) WITHOUT ROWID, STRICT;
-- statement
INSERT INTO metric_points_v3(name, category, tier, ts, value, max, samples, last_ts)
SELECT name, category, 'raw', ts, value, value, 1, ts FROM metric_points;
-- statement
DROP TABLE metric_points;
-- statement
ALTER TABLE metric_points_v3 RENAME TO metric_points;
-- statement
CREATE INDEX metric_points_category_tier_ts ON metric_points(category, tier, ts);
