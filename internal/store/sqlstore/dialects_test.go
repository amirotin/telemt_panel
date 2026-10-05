package sqlstore

import "testing"

func TestUpsertSQL(t *testing.T) {
	want := "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
	if got := Upsert("settings", []string{"key"}, []string{"value"}); got != want {
		t.Fatalf("Upsert = %q, want %q", got, want)
	}
}

func TestUpsertRejectsUnsafeIdentifiers(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("unsafe identifier did not panic")
		}
	}()
	Upsert("settings; DROP TABLE sessions", []string{"key"}, []string{"value"})
}

func TestUpsertWithoutUpdates(t *testing.T) {
	want := "INSERT INTO locks (name) VALUES (?) ON CONFLICT (name) DO NOTHING"
	if got := Upsert("locks", []string{"name"}, nil); got != want {
		t.Fatalf("Upsert without updates = %q, want %q", got, want)
	}
}
