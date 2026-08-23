package logs

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// checkOrigin validates the WebSocket origin header by exact host match,
// mirroring the check in internal/ws. A substring match would accept
// attacker-controlled origins that merely embed the panel's host.
func checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	host := r.Host
	if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" {
		host = fwd
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return parsed.Host == host
}

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: checkOrigin,
}

// ClientMsg is a message from the client.
type ClientMsg struct {
	Action string `json:"action"` // "start", "stop", "history"
	Lines  int    `json:"lines"`
	Since  string `json:"since"`
}

// ServerMsg is a message to the client.
type ServerMsg struct {
	Type      string   `json:"type"`            // "line", "history", "status", "error"
	Data      string   `json:"data,omitempty"`  // single line
	Lines     []string `json:"lines,omitempty"` // history lines
	Count     int      `json:"count,omitempty"` // history count
	Streaming bool     `json:"streaming,omitempty"`
	Message   string   `json:"message,omitempty"` // error message
	Timestamp int64    `json:"timestamp"`
}

// WsHandler handles WebSocket connections for log streaming.
type WsHandler struct {
	source LogSource

	mu       sync.Mutex
	perUser  map[string]int // per-user connection count
	maxConns int            // max connections per user
}

// NewWsHandler creates a new WebSocket handler for logs.
func NewWsHandler(source LogSource, maxConnsPerUser int) *WsHandler {
	if maxConnsPerUser <= 0 {
		maxConnsPerUser = 2
	}
	return &WsHandler{source: source, perUser: make(map[string]int), maxConns: maxConnsPerUser}
}

func (h *WsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Username is set by RequireAuth middleware
	user := r.Header.Get("X-Auth-User")

	h.mu.Lock()
	if h.perUser[user] >= h.maxConns {
		h.mu.Unlock()
		http.Error(w, "too many log connections", http.StatusTooManyRequests)
		return
	}
	h.perUser[user]++
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		h.perUser[user]--
		if h.perUser[user] <= 0 {
			delete(h.perUser, user)
		}
		h.mu.Unlock()
	}()

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("logs ws upgrade: %v", err)
		return
	}
	defer conn.Close()

	// Connection-scoped context
	connCtx, connCancel := context.WithCancel(context.Background())
	defer connCancel()

	var (
		mu        sync.Mutex
		streamMu  sync.Mutex
		cancel    context.CancelFunc
		streaming bool
		streamSeq int64
	)

	send := func(msg ServerMsg) {
		mu.Lock()
		defer mu.Unlock()
		msg.Timestamp = time.Now().UnixMilli()
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		conn.WriteJSON(msg)
	}

	stopStream := func() {
		streamMu.Lock()
		defer streamMu.Unlock()
		if cancel != nil {
			cancel()
			cancel = nil
		}
		streaming = false
		streamSeq++
	}

	defer stopStream()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var msg ClientMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			send(ServerMsg{Type: "error", Message: "invalid message"})
			continue
		}

		switch msg.Action {
		case "start":
			stopStream()

			if msg.Lines == 0 {
				msg.Lines = 200
			}
			lines := ClampLines(msg.Lines)
			opts := LogOptions{Since: NormalizeSince(msg.Since)}

			// Send history first
			history, err := h.source.Tail(connCtx, lines, opts)
			if err != nil {
				send(ServerMsg{Type: "error", Message: err.Error()})
				continue
			}
			send(ServerMsg{Type: "history", Lines: history, Count: len(history)})

			// Start streaming
			ctx, c := context.WithCancel(connCtx)
			streamMu.Lock()
			streamSeq++
			thisStream := streamSeq
			cancel = c
			streaming = true
			streamMu.Unlock()

			ch, err := h.source.Stream(ctx, opts)
			if err != nil {
				cancel()
				streamMu.Lock()
				streamSeq++
				cancel = nil
				streaming = false
				streamMu.Unlock()
				send(ServerMsg{Type: "error", Message: err.Error()})
				continue
			}

			send(ServerMsg{Type: "status", Streaming: true})

			go func() {
				for line := range ch {
					send(ServerMsg{Type: "line", Data: line})
				}
				// Channel closed — process exited unexpectedly or context cancelled
				streamMu.Lock()
				if thisStream != streamSeq {
					streamMu.Unlock()
					return
				}
				wasStreaming := streaming
				streaming = false
				cancel = nil
				streamMu.Unlock()
				if wasStreaming {
					send(ServerMsg{Type: "error", Message: "Log stream ended unexpectedly"})
					send(ServerMsg{Type: "status", Streaming: false})
				}
			}()

		case "stop":
			stopStream()
			send(ServerMsg{Type: "status", Streaming: false})

		case "history":
			streamMu.Lock()
			isStreaming := streaming
			streamMu.Unlock()
			if isStreaming {
				send(ServerMsg{Type: "error", Message: "Cannot fetch history while streaming. Stop the stream first."})
				continue
			}

			if msg.Lines == 0 {
				msg.Lines = 200
			}
			lines := ClampLines(msg.Lines)
			opts := LogOptions{Since: NormalizeSince(msg.Since)}
			history, err := h.source.Tail(connCtx, lines, opts)
			if err != nil {
				send(ServerMsg{Type: "error", Message: err.Error()})
				continue
			}
			send(ServerMsg{Type: "history", Lines: history, Count: len(history)})

		default:
			send(ServerMsg{Type: "error", Message: "unknown action: " + msg.Action})
		}
	}
}
