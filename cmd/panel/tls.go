package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/paneltls"
)

func runTLSCommand(args []string) error {
	if len(args) == 1 && args[0] == "prepare" {
		// The subprocess protocol contains only candidate input and public chain
		// output; suppress CA error bodies and token-bearing diagnostics entirely.
		slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
		return runTLSPrepare(os.Stdin, os.Stdout)
	}
	usage := errors.New("usage: telemt-panel tls check|fingerprint --config config.toml [--timeout 120s] [--expect-fingerprint HEX]")
	if len(args) == 0 || (args[0] != "check" && args[0] != "fingerprint") {
		return usage
	}
	flags := flag.NewFlagSet("tls check", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	path := flags.String("config", "config.toml", "panel config")
	wait := flags.Duration("timeout", 120*time.Second, "readiness deadline")
	fingerprint := flags.String("expect-fingerprint", "", "pre-update health response digest")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || *wait <= 0 || *wait > 10*time.Minute {
		return usage
	}
	source, err := loadStartupSource(*path)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), *wait)
	defer cancel()
	if args[0] == "fingerprint" {
		if *fingerprint != "" {
			return usage
		}
		value, err := paneltls.Fingerprint(ctx, source.Config)
		if err != nil {
			return err
		}
		fmt.Println(value)
		return nil
	}
	if *fingerprint != "" {
		err = paneltls.CheckFingerprint(ctx, source.Config, *fingerprint)
	} else {
		err = paneltls.Check(ctx, source.Config, version)
	}
	if err != nil {
		return err
	}
	fmt.Println("Configured panel transport is ready")
	return nil
}

func runTLSPrepare(input io.Reader, output io.Writer) error {
	var candidate config.TLSCandidate
	decoder := json.NewDecoder(io.LimitReader(input, 16<<10+1))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&candidate) != nil || decoder.Decode(new(any)) != io.EOF || candidate.TLS.Mode != "acme" || candidate.Normalize("") != nil {
		return errors.New("invalid ACME preparation candidate")
	}
	ctx, cancel := context.WithTimeout(context.Background(), paneltls.PrepareTimeout)
	defer cancel()
	chain, err := paneltls.AcquireInProcess(ctx, candidate)
	if err != nil {
		return errors.New("certificate preparation failed; inspect DNS, public port 80 and cache permissions")
	}
	return json.NewEncoder(output).Encode(chain)
}
