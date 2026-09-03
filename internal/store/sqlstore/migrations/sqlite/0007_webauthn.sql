CREATE TABLE auth_webauthn_user (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    user_handle BLOB NOT NULL CHECK (length(user_handle) = 64)
);

-- statement
CREATE TABLE auth_webauthn_credentials (
    credential_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    credential_data BLOB NOT NULL,
    sign_count INTEGER NOT NULL CHECK (sign_count >= 0),
    created INTEGER NOT NULL,
    last_used INTEGER NOT NULL DEFAULT 0
);

-- statement
CREATE TABLE auth_webauthn_challenges (
    flow_hash TEXT PRIMARY KEY CHECK (length(flow_hash) = 64),
    kind TEXT NOT NULL,
    session_data BLOB NOT NULL,
    origin TEXT NOT NULL,
    rp_id TEXT NOT NULL,
    expires INTEGER NOT NULL
);

-- statement
CREATE INDEX auth_webauthn_challenges_expires_idx ON auth_webauthn_challenges(expires);
