CREATE TABLE auth_totp (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    secret TEXT NOT NULL DEFAULT '',
    pending_secret TEXT NOT NULL DEFAULT '',
    pending_expires INTEGER NOT NULL DEFAULT 0,
    last_timestep INTEGER NOT NULL DEFAULT -1
);

-- statement
INSERT INTO auth_totp(singleton) VALUES (1);

-- statement
CREATE TABLE auth_recovery_codes (
    code_hash BLOB PRIMARY KEY CHECK (length(code_hash) = 32)
);
