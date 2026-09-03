CREATE TABLE auth_webauthn_user (
    singleton TINYINT PRIMARY KEY,
    user_handle BINARY(64) NOT NULL,
    CHECK (singleton = 1)
);

-- statement
CREATE TABLE auth_webauthn_credentials (
    credential_id VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    credential_data LONGBLOB NOT NULL,
    sign_count BIGINT UNSIGNED NOT NULL,
    created BIGINT NOT NULL,
    last_used BIGINT NOT NULL DEFAULT 0
);

-- statement
CREATE TABLE auth_webauthn_challenges (
    flow_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    kind VARCHAR(32) NOT NULL,
    session_data BLOB NOT NULL,
    origin VARCHAR(2048) NOT NULL,
    rp_id VARCHAR(255) NOT NULL,
    expires BIGINT NOT NULL,
    INDEX auth_webauthn_challenges_expires_idx (expires)
);
