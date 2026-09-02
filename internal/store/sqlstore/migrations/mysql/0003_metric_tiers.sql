ALTER TABLE metric_points
    ADD COLUMN tier VARCHAR(8) NOT NULL DEFAULT 'raw',
    ADD COLUMN max DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN samples BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN last_ts BIGINT NOT NULL DEFAULT 0;
-- statement
UPDATE metric_points SET max = value, last_ts = ts;
-- statement
ALTER TABLE metric_points DROP PRIMARY KEY, ADD PRIMARY KEY(name, tier, ts);
-- statement
CREATE INDEX metric_points_category_tier_ts ON metric_points(category, tier, ts);
