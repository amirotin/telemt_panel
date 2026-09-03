CREATE TABLE metric_points (
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    ts INTEGER NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY(name, ts)
) WITHOUT ROWID, STRICT;
