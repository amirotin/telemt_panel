package host

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"time"
)

// defaultAgentDialTimeout bounds connecting to the panel-agent socket.
const defaultAgentDialTimeout = 3 * time.Second

// defaultAgentOpTimeout bounds one op's round trip once connected: write
// the request frame, wait for the agent to execute it, read the reply.
// Generous for install/restore (a local file copy) and restart-service
// (a service manager command), which are the slowest ops.
const defaultAgentOpTimeout = 30 * time.Second

// agentClient is a Runner that dials the panel-agent's unix socket once
// per op — no persistent connection or multiplexing, matching the
// protocol's one-request-one-reply-per-connection shape.
type agentClient struct {
	socketPath  string
	dialTimeout time.Duration
	opTimeout   time.Duration
}

// NewAgentClient builds a Runner that executes ops by dialing the
// panel-agent unix socket at socketPath, one fresh connection per op,
// bounded by opTimeout (falling back to defaultAgentOpTimeout when <= 0).
func NewAgentClient(socketPath string, opTimeout time.Duration) Runner {
	if opTimeout <= 0 {
		opTimeout = defaultAgentOpTimeout
	}
	return &agentClient{socketPath: socketPath, dialTimeout: defaultAgentDialTimeout, opTimeout: opTimeout}
}

// Run implements Runner: dial, send op as one framed JSON request, read
// one framed JSON AgentResponse, translate a false "ok" into an error.
// The agent is the final authority on validating op's args against its
// own --allow-dest/--allow-service lists — this client does not
// pre-validate anything itself.
func (c *agentClient) Run(ctx context.Context, op Op) (Output, error) {
	conn, err := net.DialTimeout("unix", c.socketPath, c.dialTimeout)
	if err != nil {
		return Output{}, fmt.Errorf("host: dial panel-agent at %q: %w", c.socketPath, err)
	}
	defer conn.Close()

	deadline := time.Now().Add(c.opTimeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return Output{}, fmt.Errorf("host: set panel-agent connection deadline: %w", err)
	}

	// Closing conn on ctx cancellation (not just its deadline) lets a
	// caller abort a slow op early even when opTimeout hasn't elapsed.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-stop:
		}
	}()

	payload, err := json.Marshal(op)
	if err != nil {
		return Output{}, fmt.Errorf("host: marshal op: %w", err)
	}
	if err := WriteFrame(conn, payload); err != nil {
		return Output{}, err
	}

	replyPayload, err := ReadFrame(conn)
	if err != nil {
		return Output{}, err
	}
	var reply AgentResponse
	if err := json.Unmarshal(replyPayload, &reply); err != nil {
		return Output{}, fmt.Errorf("host: unmarshal panel-agent reply: %w", err)
	}
	if !reply.OK {
		return Output{}, fmt.Errorf("host: panel-agent: %s", reply.Error)
	}
	return Output{Stdout: reply.Stdout}, nil
}
