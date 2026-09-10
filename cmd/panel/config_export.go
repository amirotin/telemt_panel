package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/migration"
	"github.com/amirotin/telemt_panel/internal/store"
)

func runLegacyConfigExport(source *config.Source, outPath string, output io.Writer) error {
	if source.Legacy == nil || source.Config.DataDir == "" {
		return errors.New("export requires a 0.6 configuration with persistent data_dir")
	}
	// Do not use resolveStatePath: export must not initialize directories or state.
	statePath := filepath.Join(source.Config.DataDir, panelStateFile)
	info, err := os.Lstat(statePath)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("export requires an existing regular panel-state.json from 1.x compatibility startup")
	}
	state, err := store.NewState(statePath)
	if err != nil {
		return errors.New("cannot read existing state; configuration was not exported")
	}
	defer state.Close()
	report, err := migration.PrepareLegacyExport(state, source)
	if err != nil {
		return err
	}
	var encoded bytes.Buffer
	if err := toml.NewEncoder(&encoded).Encode(source.Config); err != nil {
		return errors.New("cannot encode current configuration")
	}
	if _, err := config.DecodeSource(encoded.Bytes(), outPath, "current"); err != nil {
		return errors.New("exported configuration failed current-format validation")
	}
	if err := writeExclusiveFile(outPath, func(w io.Writer) error {
		_, err := w.Write(encoded.Bytes())
		return err
	}); err != nil {
		return errors.New("cannot create configuration output (it must not exist; check directory and permissions)")
	}
	// Only fixed labels are printed. Credentials belong solely in the 0600 file.
	return json.NewEncoder(output).Encode(struct {
		Status     string   `json:"status"`
		Pending    []string `json:"pending"`
		NotApplied []string `json:"not_applied"`
	}{Status: report.Status, Pending: report.Pending, NotApplied: report.NotApplied})
}
