package telemt

import (
	"context"
	"net/http"
	"testing"
)

func TestMutationRejectsGray200(t *testing.T) {
	for _, body := range []string{"", " \n\t ", "not JSON", `{"ok":true}`, `{"ok":true,"data":null}`, `{"ok":true,"error":{"code":"broken"}}`, `{"ok":false}`, `null`} {
		t.Run(body, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) })
			if err := c.DeleteUser(context.Background(), "alice"); err == nil {
				t.Fatalf("unconfirmed mutation accepted: %q", body)
			}
		})
	}
}

func TestMutationRetainsNativeAndLegacyJSON(t *testing.T) {
	for _, body := range []string{`{"ok":true,"data":{}}`, `{}`, `[]`, `{"deleted":true}`} {
		t.Run(body, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) })
			if err := c.DeleteUser(context.Background(), "alice"); err != nil {
				t.Fatal(err)
			}
		})
	}
}
