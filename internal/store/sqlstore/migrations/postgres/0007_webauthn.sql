CREATE TABLE auth_webauthn_user (
    singleton SMALLINT PRIMARY KEY CHECK (singleton = 1),
    user_handle BYTEA NOT NULL CHECK (octet_length(user_handle) = 64)
);

-- statement
CREATE TABLE auth_webauthn_credentials (
    credential_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    credential_data BYTEA NOT NULL,
    sign_count BIGINT NOT NULL CHECK (sign_count >= 0),
    created BIGINT NOT NULL,
    last_used BIGINT NOT NULL DEFAULT 0
);

-- statement
CREATE TABLE auth_webauthn_challenges (
    flow_hash TEXT PRIMARY KEY CHECK (length(flow_hash) = 64),
    kind TEXT NOT NULL,
    session_data BYTEA NOT NULL,
    origin TEXT NOT NULL,
    rp_id TEXT NOT NULL,
    expires BIGINT NOT NULL
);

-- statement
CREATE INDEX auth_webauthn_challenges_expires_idx ON auth_webauthn_challenges(expires);
