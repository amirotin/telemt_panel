CREATE TABLE user_traffic_users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
    since_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL,
    month_key INTEGER NOT NULL,
    month_bytes INTEGER NOT NULL CHECK(month_bytes >= 0),
    last_raw_octets INTEGER CHECK(last_raw_octets >= 0),
    last_source_started_at INTEGER,
    deleted_ts INTEGER,
    continuity TEXT NOT NULL CHECK(continuity IN ('normal', 'partial'))
) STRICT;
-- statement
CREATE TABLE user_traffic_buckets (
    user_id INTEGER NOT NULL REFERENCES user_traffic_users(id) ON DELETE CASCADE,
    tier INTEGER NOT NULL CHECK(tier IN (0, 1, 2)),
    ts INTEGER NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes > 0),
    PRIMARY KEY(user_id, tier, ts)
) WITHOUT ROWID, STRICT;
-- statement
CREATE INDEX user_traffic_buckets_tier_ts_user
    ON user_traffic_buckets(tier, ts, user_id);
-- statement
CREATE TABLE user_traffic_collector (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    last_success_ts INTEGER NOT NULL,
    source_started_at INTEGER NOT NULL,
    source_state TEXT NOT NULL CHECK(source_state IN ('collecting', 'paused', 'unavailable')),
    continuity TEXT NOT NULL CHECK(continuity IN ('normal', 'partial'))
) STRICT;
-- statement
INSERT INTO user_traffic_users (
    username, total_bytes, since_ts, updated_ts, month_key, month_bytes,
    last_raw_octets, last_source_started_at, continuity
)
WITH traffic AS (
    SELECT
        substr(name, 6, length(name) - 13) AS username,
        tier,
        ts,
        value,
        last_ts,
        max(CASE WHEN tier = '1h' THEN 1 ELSE 0 END)
            OVER (PARTITION BY name) AS has_hour
    FROM metric_points
    WHERE category = 'user_traffic'
      AND name LIKE 'user.%.traffic'
      AND tier IN ('15m', '1h')
), selected AS (
    SELECT * FROM traffic
    WHERE (has_hour = 1 AND tier = '1h')
       OR (has_hour = 0 AND tier = '15m')
)
SELECT
    username,
    sum(value),
    min(ts),
    max(last_ts),
    CAST(strftime('%Y%m', 'now') AS INTEGER),
    sum(CASE
        WHEN strftime('%Y%m', ts, 'unixepoch') = strftime('%Y%m', 'now') THEN value
        ELSE 0
    END),
    NULL,
    NULL,
    'normal'
FROM selected
GROUP BY username;
-- statement
INSERT INTO user_traffic_buckets (user_id, tier, ts, bytes)
SELECT users.id, 0, points.ts, points.value
FROM metric_points AS points
JOIN user_traffic_users AS users
  ON users.username = substr(points.name, 6, length(points.name) - 13)
WHERE points.category = 'user_traffic'
  AND points.name LIKE 'user.%.traffic'
  AND points.tier = '15m'
  AND points.value > 0;
-- statement
INSERT INTO user_traffic_buckets (user_id, tier, ts, bytes)
SELECT users.id, 1, points.ts, points.value
FROM metric_points AS points
JOIN user_traffic_users AS users
  ON users.username = substr(points.name, 6, length(points.name) - 13)
WHERE points.category = 'user_traffic'
  AND points.name LIKE 'user.%.traffic'
  AND points.tier = '1h'
  AND points.value > 0;
-- statement
INSERT INTO user_traffic_buckets (user_id, tier, ts, bytes)
SELECT
    users.id,
    2,
    points.ts - (points.ts % 86400),
    sum(points.value)
FROM metric_points AS points
JOIN user_traffic_users AS users
  ON users.username = substr(points.name, 6, length(points.name) - 13)
WHERE points.category = 'user_traffic'
  AND points.name LIKE 'user.%.traffic'
  AND points.tier = '1h'
  AND points.value > 0
GROUP BY users.id, points.ts - (points.ts % 86400);
-- statement
DELETE FROM metric_points WHERE category = 'user_traffic';
