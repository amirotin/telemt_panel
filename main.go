package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"golang.org/x/term"

	"github.com/telemt/telemt-panel/internal/auth"
	"github.com/telemt/telemt-panel/internal/config"
	"github.com/telemt/telemt-panel/internal/server"
)

var version = "0.1.0"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println("telemt-panel " + version)
		return
	}

	if len(os.Args) > 1 && os.Args[1] == "hash-password" {
		var password string
		if term.IsTerminal(int(os.Stdin.Fd())) {
			fmt.Print("Enter password: ")
			passwordBytes, err := term.ReadPassword(int(os.Stdin.Fd()))
			fmt.Println()
			if err != nil {
				log.Fatalf("Failed to read password: %v", err)
			}
			password = string(passwordBytes)
		} else {
			scanner := bufio.NewScanner(os.Stdin)
			if scanner.Scan() {
				password = strings.TrimSpace(scanner.Text())
			}
			if password == "" {
				log.Fatal("No password provided on stdin")
			}
		}
		hash, err := auth.HashPassword(password)
		if err != nil {
			log.Fatalf("Failed to hash password: %v", err)
		}
		fmt.Println(hash)
		return
	}

	configPath := flag.String("config", "config.toml", "path to config file")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Graceful shutdown on SIGINT/SIGTERM: in-flight requests (including
	// non-atomic Telemt config writes) get a chance to finish before exit.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	srv := server.New(cfg)
	if err := srv.Run(ctx, version, distFS); err != nil {
		log.Fatal(err)
	}
}
