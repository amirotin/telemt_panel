CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    created_ns INTEGER NOT NULL,
    last_seen_ns INTEGER NOT NULL,
    ip TEXT NOT NULL,
    user_agent_label TEXT NOT NULL,
    auth_method TEXT NOT NULL
) STRICT;
-- statement
CREATE TABLE audit_entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ns INTEGER NOT NULL,
    id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    target TEXT NOT NULL,
    outcome TEXT NOT NULL,
    ip TEXT NOT NULL,
    subject TEXT NOT NULL,
    detail TEXT NOT NULL
) STRICT;
-- statement
CREATE INDEX audit_entries_ts ON audit_entries(ts_ns DESC, seq DESC);
-- statement
CREATE TABLE update_journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,
    run_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    version_from TEXT NOT NULL,
    version_to TEXT NOT NULL,
    ts_ns INTEGER NOT NULL,
    detail TEXT NOT NULL
) STRICT;
-- statement
CREATE INDEX update_journal_target_seq ON update_journal(target, seq DESC);
-- statement
CREATE TABLE metric_points (
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    ts INTEGER NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY(name, ts)
) WITHOUT ROWID, STRICT;
-- statement
CREATE TABLE subpage_nonces (
    username TEXT PRIMARY KEY,
    nonce TEXT NOT NULL
) STRICT;
-- statement
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;
-- statement
CREATE TABLE storage_policies (
    category TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 3650)
) STRICT;
-- statement
INSERT INTO storage_policies(category, enabled, retention_days) VALUES
    ('technical', 1, 7),
    ('events', 1, 30),
    ('audit', 1, 90),
    ('connection_issues', 1, 14),
    ('traffic', 1, 7),
    ('user_traffic', 0, 30),
    ('diagnostics', 0, 7);
