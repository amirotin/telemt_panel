CREATE TABLE metric_points_v11 (
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    tier TEXT NOT NULL CHECK(tier IN ('raw', '1m', '5m', '15m', '1h')),
    ts INTEGER NOT NULL,
    value REAL NOT NULL,
    max REAL NOT NULL,
    samples INTEGER NOT NULL CHECK(samples > 0),
    last_ts INTEGER NOT NULL,
    min_value REAL,
    first_ts INTEGER NOT NULL DEFAULT 0,
    first_value REAL NOT NULL DEFAULT 0,
    delta REAL,
    observed_seconds INTEGER NOT NULL DEFAULT 0 CHECK(observed_seconds >= 0),
    gaps INTEGER NOT NULL DEFAULT 0 CHECK(gaps >= 0),
    PRIMARY KEY(name, tier, ts)
) WITHOUT ROWID, STRICT;
-- statement
INSERT INTO metric_points_v11(name, category, tier, ts, value, max, samples, last_ts)
SELECT name, category, tier, ts, value, max, samples, last_ts FROM metric_points;
-- statement
DROP TABLE metric_points;
-- statement
ALTER TABLE metric_points_v11 RENAME TO metric_points;
-- statement
CREATE INDEX metric_points_category_tier_ts ON metric_points(category, tier, ts);
