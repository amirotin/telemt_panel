package bot

import (
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

const restartDelay = 15 * time.Second

// Status is the snapshot returned by Manager.Status().
type Status struct {
	Running   bool   `json:"running"`
	PID       int    `json:"pid,omitempty"`
	LastError string `json:"last_error,omitempty"`
}

// Manager runs the Python bot as a supervised subprocess.
// It restarts the process automatically if it exits unexpectedly.
type Manager struct {
	mu         sync.Mutex
	process    *os.Process
	started    bool
	lastError  string
	cancel     context.CancelFunc

	pythonPath string
	scriptPath string
	configPath string
}

// New creates a Manager. pythonPath is the Python interpreter (e.g. "python3"),
// scriptPath is the absolute path to bot.py, configPath is passed as
// PANEL_CONFIG_PATH so the bot can read token / admin_ids from the panel config.
func New(pythonPath, scriptPath, configPath string) *Manager {
	return &Manager{
		pythonPath: pythonPath,
		scriptPath: scriptPath,
		configPath: configPath,
	}
}

// Start launches the bot subprocess. Idempotent — safe to call if already running.
func (m *Manager) Start() {
	m.mu.Lock()
	if m.started {
		m.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.started = true
	m.mu.Unlock()

	log.Printf("Bot manager: starting (python=%s script=%s)", m.pythonPath, m.scriptPath)
	go m.loop(ctx)
}

// Stop terminates the bot subprocess and cancels the restart loop.
func (m *Manager) Stop() {
	m.mu.Lock()
	if !m.started {
		m.mu.Unlock()
		return
	}
	m.started = false
	cancel := m.cancel
	m.cancel = nil
	m.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	log.Printf("Bot manager: stopped")
}

// IsStarted reports whether Start() has been called and Stop() has not.
func (m *Manager) IsStarted() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.started
}

// Status returns a snapshot of the current bot process state.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	pid := 0
	if m.process != nil {
		pid = m.process.Pid
	}
	return Status{
		Running:   m.process != nil,
		PID:       pid,
		LastError: m.lastError,
	}
}

// ensureDeps runs pip install for the bot's requirements.txt once before the
// restart loop starts. Errors are non-fatal — the bot may still work if the
// packages are already installed system-wide (common in Docker images).
// ensureDeps installs the bot's Python dependencies before the first start.
// Tries pip install strategies in order until one succeeds. Errors are
// non-fatal — the bot may still work if packages are already installed
// system-wide (e.g. pre-installed in a Docker image).
func (m *Manager) ensureDeps(ctx context.Context) {
	reqPath := filepath.Join(filepath.Dir(m.scriptPath), "requirements.txt")
	if _, err := os.Stat(reqPath); os.IsNotExist(err) {
		return
	}
	log.Printf("Bot: installing Python dependencies from %s", reqPath)
	strategies := [][]string{
		{"-m", "pip", "install", "-r", reqPath, "--quiet"},
		{"-m", "pip", "install", "-r", reqPath, "--quiet", "--user"},
		{"-m", "pip", "install", "-r", reqPath, "--quiet", "--break-system-packages"},
	}
	for _, args := range strategies {
		cmd := exec.CommandContext(ctx, m.pythonPath, args...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err == nil {
			return
		}
	}
	log.Printf("Bot: pip install failed with all strategies (bot may still work if deps are installed system-wide)")
}

func (m *Manager) loop(ctx context.Context) {
	m.ensureDeps(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		cmd := exec.CommandContext(ctx, m.pythonPath, m.scriptPath)
		env := os.Environ()
		if m.configPath != "" {
			env = append(env, "PANEL_CONFIG_PATH="+m.configPath)
		}
		cmd.Env = env
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr

		if err := cmd.Start(); err != nil {
			m.mu.Lock()
			m.lastError = err.Error()
			m.mu.Unlock()
			log.Printf("Bot: failed to start: %v", err)
		} else {
			m.mu.Lock()
			m.process = cmd.Process
			m.lastError = ""
			m.mu.Unlock()

			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()

			select {
			case <-ctx.Done():
				<-done
				m.mu.Lock()
				m.process = nil
				m.mu.Unlock()
				return
			case err := <-done:
				m.mu.Lock()
				m.process = nil
				if err != nil && ctx.Err() == nil {
					m.lastError = err.Error()
					log.Printf("Bot: exited with error: %v, restarting in %v", err, restartDelay)
				} else if ctx.Err() == nil {
					log.Printf("Bot: exited cleanly, restarting in %v", restartDelay)
				}
				m.mu.Unlock()

				if ctx.Err() != nil {
					return
				}
			}
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(restartDelay):
		}
	}
}

// FindPython returns the first available Python interpreter path.
// Searches PATH first, then falls back to common installation directories
// so the bot works correctly when launched from a systemd service with a minimal PATH.
func FindPython(configured string) string {
	if configured != "" {
		return configured
	}
	// Try names via PATH
	for _, name := range []string{"python3", "python"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	// Fall back to well-known absolute paths (common on Linux/macOS)
	candidates := []string{
		"/usr/bin/python3",
		"/usr/local/bin/python3",
		"/usr/bin/python",
		"/usr/local/bin/python",
		"/opt/homebrew/bin/python3",
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "python3"
}
