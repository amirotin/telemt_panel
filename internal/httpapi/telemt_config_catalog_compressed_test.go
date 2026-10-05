package httpapi

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func TestCompressedCatalogMatchesSource(t *testing.T) {
	raw, err := os.ReadFile("telemt_config_catalog_3_5_5.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected telemtConfigCatalog
	if err := json.Unmarshal(raw, &expected); err != nil {
		t.Fatal(err)
	}
	got, err := decodeTelemtConfigCatalog(telemtConfigCatalogPacked)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(expected)
	b, _ := json.Marshal(got)
	if !bytes.Equal(a, b) {
		t.Fatal("compressed catalog changed fields")
	}
}

func TestCompressedCatalogRejectsCorruption(t *testing.T) {
	checksum := []byte(telemtConfigCatalogPacked)
	checksum[len(checksum)-8] ^= 1
	for _, packed := range []string{"bad", telemtConfigCatalogPacked[:len(telemtConfigCatalogPacked)/2], string(checksum)} {
		if _, err := decodeTelemtConfigCatalog(packed); err == nil {
			t.Fatal("corrupt gzip accepted")
		}
	}
}
