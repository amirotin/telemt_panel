CREATE TABLE history_events (
    seq BIGSERIAL PRIMARY KEY,
    ts_ns BIGINT NOT NULL,
    category TEXT NOT NULL,
    kind TEXT NOT NULL,
    entity TEXT NOT NULL,
    state TEXT NOT NULL,
    previous_state TEXT NOT NULL,
    severity TEXT NOT NULL,
    attributes_json TEXT NOT NULL
);
-- statement
CREATE INDEX history_events_category_ts ON history_events(category, ts_ns DESC, seq DESC);
-- statement
CREATE INDEX history_events_kind_ts ON history_events(kind, ts_ns DESC, seq DESC);
