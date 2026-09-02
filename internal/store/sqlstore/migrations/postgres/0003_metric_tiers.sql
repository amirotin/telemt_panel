ALTER TABLE metric_points ADD COLUMN tier TEXT NOT NULL DEFAULT 'raw';
-- statement
ALTER TABLE metric_points ADD COLUMN max DOUBLE PRECISION NOT NULL DEFAULT 0;
-- statement
UPDATE metric_points SET max = value;
-- statement
ALTER TABLE metric_points ADD COLUMN samples BIGINT NOT NULL DEFAULT 1;
-- statement
ALTER TABLE metric_points ADD COLUMN last_ts BIGINT NOT NULL DEFAULT 0;
-- statement
UPDATE metric_points SET last_ts = ts;
-- statement
ALTER TABLE metric_points DROP CONSTRAINT metric_points_pkey;
-- statement
ALTER TABLE metric_points ADD PRIMARY KEY(name, tier, ts);
-- statement
CREATE INDEX metric_points_category_tier_ts ON metric_points(category, tier, ts);
