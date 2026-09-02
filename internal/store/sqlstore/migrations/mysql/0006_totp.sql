CREATE TABLE auth_totp (
    singleton TINYINT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    secret TEXT NOT NULL,
    pending_secret TEXT NOT NULL,
    pending_expires BIGINT NOT NULL DEFAULT 0,
    last_timestep BIGINT NOT NULL DEFAULT -1,
    CHECK (singleton = 1)
);

-- statement
INSERT INTO auth_totp(singleton, secret, pending_secret) VALUES (1, '', '');

-- statement
CREATE TABLE auth_recovery_codes (
    code_hash BINARY(32) PRIMARY KEY
);
