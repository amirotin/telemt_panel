CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    created_ns BIGINT NOT NULL,
    last_seen_ns BIGINT NOT NULL,
    ip TEXT NOT NULL,
    user_agent_label TEXT NOT NULL,
    auth_method TEXT NOT NULL
);
-- statement
CREATE TABLE audit_entries (
    seq BIGSERIAL PRIMARY KEY,
    ts_ns BIGINT NOT NULL,
    id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    target TEXT NOT NULL,
    outcome TEXT NOT NULL,
    ip TEXT NOT NULL,
    subject TEXT NOT NULL,
    detail TEXT NOT NULL
);
-- statement
CREATE INDEX audit_entries_ts ON audit_entries(ts_ns DESC, seq DESC);
-- statement
CREATE TABLE update_journal (
    seq BIGSERIAL PRIMARY KEY,
    target TEXT NOT NULL,
    run_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    version_from TEXT NOT NULL,
    version_to TEXT NOT NULL,
    ts_ns BIGINT NOT NULL,
    detail TEXT NOT NULL
);
-- statement
CREATE INDEX update_journal_target_seq ON update_journal(target, seq DESC);
-- statement
CREATE TABLE metric_points (
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    ts BIGINT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    PRIMARY KEY(name, ts)
);
-- statement
CREATE TABLE subpage_nonces (
    username TEXT PRIMARY KEY,
    nonce TEXT NOT NULL
);
-- statement
CREATE TABLE settings (
    setting_key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- statement
CREATE TABLE storage_policies (
    category TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL,
    retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 3650)
);
-- statement
INSERT INTO storage_policies(category, enabled, retention_days) VALUES
    ('technical', TRUE, 7),
    ('events', TRUE, 30),
    ('audit', TRUE, 90),
    ('connection_issues', TRUE, 14),
    ('traffic', TRUE, 7),
    ('user_traffic', FALSE, 30),
    ('diagnostics', FALSE, 7);
