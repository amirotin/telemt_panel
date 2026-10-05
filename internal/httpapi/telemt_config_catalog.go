package httpapi

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
)

// telemtConfigCatalogJSON is generated from the audited Telemt 3.5.5
// inventory. It is the single field-path source used by validation and the
// settings UI; keeping a second hand-maintained list here would inevitably
// make one of those surfaces incomplete.
//
//go:embed telemt_config_catalog_3_5_5.json
var telemtConfigCatalogJSON []byte

type telemtConfigCatalog struct {
	Version          string              `json:"version"`
	SourceCommit     string              `json:"source_commit"`
	DocumentedFields int                 `json:"documented_fields"`
	RuntimeAdditions []string            `json:"runtime_additions"`
	Groups           []telemtConfigGroup `json:"groups"`
	Fields           []telemtConfigField `json:"fields"`
}

type telemtConfigGroup struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Short string `json:"short"`
}

type telemtConfigField struct {
	Path            string   `json:"path"`
	DataType        string   `json:"data_type"`
	Kind            string   `json:"kind"`
	Options         []string `json:"options,omitempty"`
	DefaultValue    string   `json:"default_value"`
	DocHot          bool     `json:"doc_hot"`
	Apply           string   `json:"apply"`
	Tier            string   `json:"tier"`
	Group           string   `json:"group"`
	Secret          bool     `json:"secret"`
	RuntimeAddition bool     `json:"runtime_addition,omitempty"`
}

var telemt355ConfigCatalog = mustLoadTelemtConfigCatalog()

func mustLoadTelemtConfigCatalog() telemtConfigCatalog {
	var catalog telemtConfigCatalog
	if err := json.Unmarshal(telemtConfigCatalogJSON, &catalog); err != nil {
		panic(fmt.Sprintf("decode embedded Telemt config catalog: %v", err))
	}
	if catalog.Version == "" || len(catalog.Groups) == 0 || len(catalog.Fields) == 0 {
		panic("embedded Telemt config catalog is empty")
	}
	return catalog
}

func (s *Server) handleGetTelemtConfigCatalog(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()
	writeJSON(w, http.StatusOK, telemtConfigCatalogForVersion(s.telemtConfigVersion(ctx)))
}
