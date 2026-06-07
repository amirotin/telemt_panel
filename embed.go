package main

import "embed"

//go:embed all:dist
var distFS embed.FS

//go:embed bot/bot.py bot/requirements.txt
var botFS embed.FS
