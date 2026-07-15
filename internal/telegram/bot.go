package telegram

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/pelletier/go-toml/v2"
	"github.com/telemt/telemt-panel/internal/config"
	_ "modernc.org/sqlite"
)

const monitorInterval = 60 * time.Second

// Status is the snapshot returned by Bot.Status().
type Status struct {
	Running   bool   `json:"running"`
	LastError string `json:"last_error,omitempty"`
}

// fsmState holds the in-memory FSM state for a single user.
type fsmState struct {
	State string
	Data  map[string]string
}

type ServiceActions struct {
	RestartTelemt func() error
	RestartPanel  func() error
}

// Bot is the Telegram bot running as goroutines inside the panel process.
type Bot struct {
	cfg        *config.Config
	mu         sync.Mutex
	wg         sync.WaitGroup
	api        *tgbotapi.BotAPI
	db         *sql.DB
	states     map[int64]*fsmState
	started    bool
	cancel     context.CancelFunc
	lastError  string
	httpClient *http.Client

	// Proxy domain info loaded from telemt config.
	domain    string
	port      int
	tlsDomain string
	actions   ServiceActions
}

// New creates a Bot. Call Start() to begin polling.
func New(cfg *config.Config) *Bot {
	return &Bot{
		cfg:        cfg,
		states:     make(map[int64]*fsmState),
		port:       4448,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// Start launches the bot. Idempotent — safe to call if already started.
func (b *Bot) Start() error {
	b.mu.Lock()
	if b.started {
		b.mu.Unlock()
		return nil
	}
	b.started = true                 // claim the slot before releasing the lock
	token := b.cfg.Telegram.BotToken // snapshot under lock; UpdateConfig may race otherwise
	b.mu.Unlock()

	api, err := tgbotapi.NewBotAPI(token)
	if err != nil {
		b.mu.Lock()
		b.started = false
		b.lastError = err.Error()
		b.mu.Unlock()
		return fmt.Errorf("invalid bot token: %w", err)
	}

	dbPath := filepath.Join(b.cfg.DataDir, "bot", "users.db")
	if err := os.MkdirAll(filepath.Dir(dbPath), 0755); err != nil {
		b.mu.Lock()
		b.started = false
		b.mu.Unlock()
		return fmt.Errorf("create bot dir: %w", err)
	}
	db, err := sql.Open("sqlite", dbPath+"?_journal_mode=WAL&_timeout=5000")
	if err != nil {
		b.mu.Lock()
		b.started = false
		b.mu.Unlock()
		return fmt.Errorf("open db: %w", err)
	}
	if err := initSchema(db); err != nil {
		db.Close()
		b.mu.Lock()
		b.started = false
		b.mu.Unlock()
		return fmt.Errorf("init schema: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())

	b.mu.Lock()
	b.api = api
	b.db = db
	b.cancel = cancel
	b.lastError = ""
	b.mu.Unlock()

	b.loadDomainInfo()

	b.mu.Lock()
	domain := b.domain
	port := b.port
	b.mu.Unlock()
	log.Printf("[telegram] bot started, domain=%s port=%d", domain, port)

	b.wg.Add(3)
	go b.run(ctx)
	go b.monitorLoop(ctx)
	go func() {
		defer b.wg.Done()
		b.notifyAdmins("🔄 <b>Панель перезапущена.</b> Бот снова в сети.")
	}()
	return nil
}

// Stop terminates the bot.
func (b *Bot) Stop() {
	b.mu.Lock()
	if !b.started {
		b.mu.Unlock()
		return
	}
	cancel := b.cancel
	db := b.db
	b.started = false
	b.cancel = nil
	b.api = nil
	b.db = nil
	b.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	b.wg.Wait() // drain all tracked goroutines before closing DB
	if db != nil {
		db.Close()
	}
	log.Printf("[telegram] bot stopped")
}

// Status returns a snapshot of the current bot state.
func (b *Bot) Status() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	return Status{Running: b.started, LastError: b.lastError}
}

func (b *Bot) SetServiceActions(actions ServiceActions) {
	b.mu.Lock()
	b.actions = actions
	b.mu.Unlock()
}

func (b *Bot) loadDomainInfo() {
	if b.cfg.Telemt.ConfigPath == "" {
		return
	}
	data, err := os.ReadFile(b.cfg.Telemt.ConfigPath)
	if err != nil {
		return
	}
	var tc struct {
		General struct {
			Links struct {
				PublicHost string `toml:"public_host"`
				PublicPort int    `toml:"public_port"`
			} `toml:"links"`
		} `toml:"general"`
		Censorship struct {
			TLSDomain string `toml:"tls_domain"`
		} `toml:"censorship"`
	}
	if err := toml.Unmarshal(data, &tc); err != nil {
		return
	}
	b.mu.Lock()
	b.domain = tc.General.Links.PublicHost
	if tc.General.Links.PublicPort > 0 {
		b.port = tc.General.Links.PublicPort
	}
	b.tlsDomain = tc.Censorship.TLSDomain
	if b.tlsDomain == "" {
		b.tlsDomain = b.domain
	}
	b.mu.Unlock()
}

func (b *Bot) run(ctx context.Context) {
	defer b.wg.Done()

	b.mu.Lock()
	api := b.api
	b.mu.Unlock()
	if api == nil {
		return
	}

	u := tgbotapi.NewUpdate(0)
	u.Timeout = 60
	updates := api.GetUpdatesChan(u)

	for {
		select {
		case update, ok := <-updates:
			if !ok {
				return
			}
			b.wg.Add(1)
			go func(u tgbotapi.Update) {
				defer b.wg.Done()
				b.handleUpdate(u)
			}(update)
		case <-ctx.Done():
			api.StopReceivingUpdates()
			return
		}
	}
}

// ── FSM helpers ────────────────────────────────────────────────────────────

func (b *Bot) getState(tgID int64) *fsmState {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.states[tgID]
}

func (b *Bot) setState(tgID int64, state string, data map[string]string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if data == nil {
		data = make(map[string]string)
	}
	b.states[tgID] = &fsmState{State: state, Data: data}
}

func (b *Bot) clearState(tgID int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.states, tgID)
}

// ── Admin / user helpers ───────────────────────────────────────────────────

// UpdateConfig atomically replaces the Telegram configuration used by bot goroutines.
func (b *Bot) UpdateConfig(t config.TelegramConfig) {
	b.mu.Lock()
	b.cfg.Telegram = t
	b.mu.Unlock()
}

// GetTelegramConfig returns a snapshot of the current Telegram configuration.
func (b *Bot) GetTelegramConfig() config.TelegramConfig {
	b.mu.Lock()
	t := b.cfg.Telegram
	b.mu.Unlock()
	return t
}

// IsConfigured reports whether the token and admin IDs are present.
func (b *Bot) IsConfigured() bool {
	b.mu.Lock()
	ok := b.cfg.Telegram.BotToken != "" && len(b.cfg.Telegram.AdminIDs) > 0
	b.mu.Unlock()
	return ok
}

// SetEnabled atomically sets the Enabled flag in the Telegram configuration.
func (b *Bot) SetEnabled(v bool) {
	b.mu.Lock()
	b.cfg.Telegram.Enabled = v
	b.mu.Unlock()
}

func (b *Bot) isAdmin(tgID int64) bool {
	b.mu.Lock()
	ids := make([]int64, len(b.cfg.Telegram.AdminIDs))
	copy(ids, b.cfg.Telegram.AdminIDs)
	b.mu.Unlock()
	for _, id := range ids {
		if id == tgID {
			return true
		}
	}
	return false
}

func (b *Bot) notifyAdmins(text string) {
	b.mu.Lock()
	ids := make([]int64, len(b.cfg.Telegram.AdminIDs))
	copy(ids, b.cfg.Telegram.AdminIDs)
	b.mu.Unlock()
	for _, id := range ids {
		b.send(id, text)
	}
}

func (b *Bot) buildProxyLink(secret string) string {
	b.mu.Lock()
	domain := b.domain
	port := b.port
	tlsDomain := b.tlsDomain
	b.mu.Unlock()
	if secret == "" || domain == "" {
		return ""
	}
	tlsHex := hex.EncodeToString([]byte(tlsDomain))
	return fmt.Sprintf("tg://proxy?server=%s&port=%d&secret=ee%s%s", domain, port, secret, tlsHex)
}

func (b *Bot) maxTCPConns() int {
	b.mu.Lock()
	v := b.cfg.Telegram.DefaultMaxTcpConns
	b.mu.Unlock()
	if v > 0 {
		return v
	}
	return 50
}

func randomHex(n int) string {
	buf := make([]byte, n)
	rand.Read(buf) //nolint:errcheck
	return hex.EncodeToString(buf)
}

// syncAndDashboard fetches users from API, syncs DB, and returns dashboard text.
func (b *Bot) syncAndDashboard() string {
	users, err := b.apiGetUsers()
	if err != nil {
		return "❌ API недоступно."
	}
	b.dbSyncUsers(users)

	b.mu.Lock()
	domain := b.domain
	b.mu.Unlock()

	var total, online int
	var totalOctets int64
	for _, u := range users {
		total++
		totalOctets += u.totalOctets
		if len(u.activeIPs) > 0 {
			online++
		}
	}
	return fmt.Sprintf(
		"💎 <b>Админ панель прокси telemt - %s</b>\n\n🟢 Клиентов онлайн: <b>%d</b>\n👥 Клиентов всего: <b>%d</b>\n📊 Суммарный трафик: <b>%s</b>",
		domain, online, total, formatTraffic(totalOctets),
	)
}
