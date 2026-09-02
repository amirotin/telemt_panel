CREATE TABLE auth_totp (
    singleton SMALLINT PRIMARY KEY CHECK (singleton = 1),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    secret TEXT NOT NULL DEFAULT '',
    pending_secret TEXT NOT NULL DEFAULT '',
    pending_expires BIGINT NOT NULL DEFAULT 0,
    last_timestep BIGINT NOT NULL DEFAULT -1
);

-- statement
INSERT INTO auth_totp(singleton) VALUES (1);

-- statement
CREATE TABLE auth_recovery_codes (
    code_hash BYTEA PRIMARY KEY CHECK (octet_length(code_hash) = 32)
);
