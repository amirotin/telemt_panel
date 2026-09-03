CREATE TABLE metric_points (
    name VARCHAR(255) NOT NULL,
    category VARCHAR(64) NOT NULL,
    ts BIGINT NOT NULL,
    value DOUBLE NOT NULL,
    PRIMARY KEY(name, ts)
) ENGINE=InnoDB;
