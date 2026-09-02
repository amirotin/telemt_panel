CREATE TABLE sessions (
    id_hash VARCHAR(128) PRIMARY KEY,
    created_ns BIGINT NOT NULL,
    last_seen_ns BIGINT NOT NULL,
    ip VARCHAR(255) NOT NULL,
    user_agent_label TEXT NOT NULL,
    auth_method VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
-- statement
CREATE TABLE audit_entries (
    seq BIGINT AUTO_INCREMENT PRIMARY KEY,
    ts_ns BIGINT NOT NULL,
    id VARCHAR(128) NOT NULL,
    action VARCHAR(255) NOT NULL,
    actor VARCHAR(255) NOT NULL,
    target VARCHAR(255) NOT NULL,
    outcome VARCHAR(64) NOT NULL,
    ip VARCHAR(255) NOT NULL,
    subject TEXT NOT NULL,
    detail TEXT NOT NULL,
    INDEX audit_entries_ts (ts_ns DESC, seq DESC)
) ENGINE=InnoDB;
-- statement
CREATE TABLE update_journal (
    seq BIGINT AUTO_INCREMENT PRIMARY KEY,
    target VARCHAR(255) NOT NULL,
    run_id VARCHAR(128) NOT NULL,
    phase VARCHAR(128) NOT NULL,
    version_from VARCHAR(128) NOT NULL,
    version_to VARCHAR(128) NOT NULL,
    ts_ns BIGINT NOT NULL,
    detail TEXT NOT NULL,
    INDEX update_journal_target_seq (target, seq DESC)
) ENGINE=InnoDB;
-- statement
CREATE TABLE metric_points (
    name VARCHAR(255) NOT NULL,
    category VARCHAR(64) NOT NULL,
    ts BIGINT NOT NULL,
    value DOUBLE NOT NULL,
    PRIMARY KEY(name, ts)
) ENGINE=InnoDB;
-- statement
CREATE TABLE subpage_nonces (
    username VARCHAR(255) PRIMARY KEY,
    nonce TEXT NOT NULL
) ENGINE=InnoDB;
-- statement
CREATE TABLE settings (
    setting_key VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL
) ENGINE=InnoDB;
-- statement
CREATE TABLE storage_policies (
    category VARCHAR(64) PRIMARY KEY,
    enabled BOOLEAN NOT NULL,
    retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 3650)
) ENGINE=InnoDB;
-- statement
INSERT INTO storage_policies(category, enabled, retention_days) VALUES
    ('technical', TRUE, 7),
    ('events', TRUE, 30),
    ('audit', TRUE, 90),
    ('connection_issues', TRUE, 14),
    ('traffic', TRUE, 7),
    ('user_traffic', FALSE, 30),
    ('diagnostics', FALSE, 7);
