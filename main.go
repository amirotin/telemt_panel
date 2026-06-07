package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/term"

	"github.com/telemt/telemt-panel/internal/auth"
	"github.com/telemt/telemt-panel/internal/config"
	"github.com/telemt/telemt-panel/internal/server"
)

var version = "0.1.0"

// extractBotAssets writes the embedded bot files into <dataDir>/bot/ on every startup,
// keeping the deployed bot.py in sync with the panel binary automatically.
func extractBotAssets(dataDir string) error {
	botDir := filepath.Join(dataDir, "bot")
	if err := os.MkdirAll(botDir, 0755); err != nil {
		return err
	}
	for _, name := range []string{"bot/bot.py", "bot/requirements.txt"} {
		data, err := botFS.ReadFile(name)
		if err != nil {
			return err
		}
		dst := filepath.Join(botDir, filepath.Base(name))
		if err := os.WriteFile(dst, data, 0644); err != nil {
			return err
		}
	}
	log.Printf("Bot assets extracted to %s", botDir)
	return nil
}

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

	// Extract embedded bot files to data dir so the panel always has bot.py available.
	if err := extractBotAssets(cfg.DataDir); err != nil {
		log.Printf("WARNING: failed to extract bot assets: %v", err)
	}

	srv := server.New(cfg)
	log.Fatal(srv.Run(version, distFS))
}
