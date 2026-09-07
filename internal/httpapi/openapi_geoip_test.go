package httpapi

import (
	"os"
	"strings"
	"testing"
)

func TestOpenAPIGeoIPHistoryUsesNullableUnion(t *testing.T) {
	for _, path := range []string{"../../api/openapi.yaml"} {
		document, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		start := strings.Index(string(document), "    UserIPHistoryItem:\n")
		end := strings.Index(string(document), "    UserIPCollection:\n")
		if start < 0 || end <= start {
			t.Fatalf("%s: UserIPHistoryItem schema not found", path)
		}
		item := string(document[start:end])
		if !strings.Contains(item, "        geo:\n") ||
			!strings.Contains(item, "          anyOf:\n            - $ref: \"#/components/schemas/GeoIpResult\"\n            - type: \"null\"\n") {
			t.Fatalf("%s: geo must be an anyOf union of GeoIpResult and null", path)
		}
	}
}
