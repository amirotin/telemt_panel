package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/httpapi"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// version is injected at build time via -ldflags.
var version = "0.0.0-dev"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println("telemt-panel " + version)
		return
	}

	configPath := flag.String("config", "config.toml", "path to config file")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		slog.Error("load config", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	tc := telemt.New(cfg.Telemt.URL, cfg.Telemt.AuthHeader)
	srv := httpapi.New(cfg, tc, version)
	if err := srv.Run(ctx); err != nil {
		slog.Error("server", "err", err)
		os.Exit(1)
	}
}
