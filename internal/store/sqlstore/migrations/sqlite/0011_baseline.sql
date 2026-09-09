CREATE TABLE metric_points (
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
CREATE INDEX metric_points_category_tier_ts ON metric_points(category, tier, ts);
-- statement
CREATE TABLE history_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ns INTEGER NOT NULL,
    category TEXT NOT NULL,
    kind TEXT NOT NULL,
    entity TEXT NOT NULL,
    state TEXT NOT NULL,
    previous_state TEXT NOT NULL,
    severity TEXT NOT NULL,
    attributes_json TEXT NOT NULL
) STRICT;
-- statement
CREATE INDEX history_events_category_ts ON history_events(category, ts_ns DESC, seq DESC);
-- statement
CREATE INDEX history_events_kind_ts ON history_events(kind, ts_ns DESC, seq DESC);
-- statement
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
CREATE TABLE user_ip_history (
    username TEXT NOT NULL,
    ip TEXT NOT NULL,
    family INTEGER NOT NULL CHECK(family IN (4,6)),
    first_ts INTEGER NOT NULL CHECK(first_ts > 0),
    last_ts INTEGER NOT NULL CHECK(last_ts >= first_ts),
    observations INTEGER NOT NULL CHECK(observations > 0),
    last_active_ts INTEGER NOT NULL DEFAULT 0,
    source INTEGER NOT NULL CHECK(source BETWEEN 1 AND 3),
    PRIMARY KEY(username, ip)
) WITHOUT ROWID, STRICT;
-- statement
CREATE INDEX user_ip_history_user_last ON user_ip_history(username, last_ts DESC, ip);
-- statement
CREATE INDEX user_ip_history_last ON user_ip_history(last_ts, username, ip);
-- statement
CREATE TABLE user_ip_history_collection (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    batch_id TEXT NOT NULL,
    since_ts INTEGER NOT NULL,
    through_ts INTEGER NOT NULL,
    limited INTEGER NOT NULL CHECK(limited IN (0,1)),
    gap INTEGER NOT NULL CHECK(gap IN (0,1))
) STRICT;
