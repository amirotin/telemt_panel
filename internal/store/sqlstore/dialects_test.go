package sqlstore

import "testing"

func TestDialectSQL(t *testing.T) {
	tests := []struct {
		name        string
		dialect     Dialect
		placeholder string
		upsert      string
	}{
		{"sqlite", SQLiteDialect{}, "?", "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"},
		{"postgres", PostgresDialect{}, "$2", "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"},
		{"mysql", MySQLDialect{}, "?", "INSERT INTO settings (key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := test.dialect.Placeholder(2); got != test.placeholder {
				t.Fatalf("Placeholder = %q", got)
			}
			if got := test.dialect.Upsert("settings", []string{"key"}, []string{"value"}); got != test.upsert {
				t.Fatalf("Upsert = %q", got)
			}
		})
	}
}

func TestUpsertRejectsUnsafeIdentifiers(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("unsafe identifier did not panic")
		}
	}()
	SQLiteDialect{}.Upsert("settings; DROP TABLE sessions", []string{"key"}, []string{"value"})
}

func TestDialectInsertWithoutUpdates(t *testing.T) {
	tests := []struct {
		name    string
		dialect Dialect
		want    string
	}{
		{"sqlite", SQLiteDialect{}, "INSERT INTO locks (name) VALUES (?) ON CONFLICT (name) DO NOTHING"},
		{"postgres", PostgresDialect{}, "INSERT INTO locks (name) VALUES ($1) ON CONFLICT (name) DO NOTHING"},
		{"mysql", MySQLDialect{}, "INSERT IGNORE INTO locks (name) VALUES (?)"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := test.dialect.Upsert("locks", []string{"name"}, nil); got != test.want {
				t.Fatalf("Upsert without updates = %q, want %q", got, test.want)
			}
		})
	}
}

func TestPostgresBind(t *testing.T) {
	got := PostgresDialect{}.Bind("SELECT * FROM metric_points WHERE name = ? AND ts >= ? LIMIT ?")
	want := "SELECT * FROM metric_points WHERE name = $1 AND ts >= $2 LIMIT $3"
	if got != want {
		t.Fatalf("Bind = %q, want %q", got, want)
	}
}
