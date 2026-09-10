package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"syscall"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/migration"
	"github.com/amirotin/telemt_panel/internal/store"
)

func runConfigCommand(args []string, output io.Writer) error {
	usage := errors.New("usage: telemt-panel config check|inspect|import-state --config config.toml --format auto|current|0.6 (stop the panel before import-state)")
	if len(args) == 0 || (args[0] != "check" && args[0] != "inspect" && args[0] != "import-state") {
		return usage
	}
	flags := flag.NewFlagSet("config "+args[0], flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	path := flags.String("config", "config.toml", "configuration file")
	format := flags.String("format", "auto", "source format: auto, current or 0.6")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || *path == "" {
		return usage
	}
	if *format != "auto" && *format != "current" && *format != "0.6" {
		return usage
	}
	data, err := readConfigSource(*path)
	if err != nil {
		return err
	}
	source, err := config.DecodeSource(data, *path, *format)
	if err != nil {
		return err
	}
	if args[0] == "import-state" {
		return runLegacyStateImport(source, output)
	}
	if args[0] == "inspect" {
		encoder := json.NewEncoder(output)
		encoder.SetIndent("", "  ")
		return encoder.Encode(source.Report())
	}
	message := "Configuration valid (current format); runtime resources not checked."
	if source.Legacy != nil {
		message = "Configuration valid (0.6 format); migration required before 1.x startup; runtime resources not checked."
	}
	if _, err := fmt.Fprintln(output, message); err != nil {
		return err
	}
	for _, warning := range source.Warnings {
		if _, err := fmt.Fprintln(output, "Warning:", warning); err != nil {
			return err
		}
	}
	return nil
}

func runLegacyStateImport(source *config.Source, output io.Writer) error {
	if source.Legacy == nil || source.Config.DataDir == "" {
		return errors.New("import-state requires a 0.6 configuration with persistent data_dir")
	}
	path, err := resolveStatePath(source.Config.DataDir)
	if err != nil {
		return errors.New("cannot prepare state directory (check data_dir and permissions)")
	}
	state, err := store.NewState(path)
	if err != nil {
		return errors.New("cannot open existing state; import was not started")
	}
	defer state.Close()
	report, err := migration.ImportLegacyState(state, source)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(report)
}

func readConfigSource(path string) ([]byte, error) {
	// Nonblocking open lets us reject a FIFO without waiting for a writer.
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, errors.New("cannot open configuration file (check path and permissions)")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("configuration input must be a regular file")
	}
	const maxSize = 1 << 20
	if info.Size() > maxSize {
		return nil, errors.New("configuration file exceeds 1 MiB")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxSize+1))
	if err != nil {
		return nil, errors.New("cannot read configuration file")
	}
	if len(data) > maxSize {
		return nil, errors.New("configuration file exceeds 1 MiB")
	}
	return data, nil
}
