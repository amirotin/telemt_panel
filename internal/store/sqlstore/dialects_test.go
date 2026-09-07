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
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := test.dialect.Upsert("locks", []string{"name"}, nil); got != test.want {
				t.Fatalf("Upsert without updates = %q, want %q", got, test.want)
			}
		})
	}
}
