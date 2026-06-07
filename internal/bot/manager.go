package bot

import (
	"context"
	"log"
	"os"
	"os/exec"
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

func (m *Manager) loop(ctx context.Context) {
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
func FindPython(configured string) string {
	if configured != "" {
		return configured
	}
	for _, name := range []string{"python3", "python"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return "python3"
}
