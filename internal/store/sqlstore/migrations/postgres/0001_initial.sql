CREATE TABLE metric_points (
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    ts BIGINT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    PRIMARY KEY(name, ts)
);
