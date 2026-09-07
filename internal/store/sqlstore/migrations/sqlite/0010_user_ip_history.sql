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
