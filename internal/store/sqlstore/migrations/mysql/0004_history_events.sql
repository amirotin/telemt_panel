CREATE TABLE history_events (
    seq BIGINT AUTO_INCREMENT PRIMARY KEY,
    ts_ns BIGINT NOT NULL,
    category VARCHAR(64) NOT NULL,
    kind VARCHAR(255) NOT NULL,
    entity VARCHAR(255) NOT NULL,
    state VARCHAR(255) NOT NULL,
    previous_state VARCHAR(255) NOT NULL,
    severity VARCHAR(32) NOT NULL,
    attributes_json TEXT NOT NULL,
    INDEX history_events_category_ts (category, ts_ns DESC, seq DESC),
    INDEX history_events_kind_ts (kind, ts_ns DESC, seq DESC)
) ENGINE=InnoDB;
