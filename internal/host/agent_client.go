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

// Per-Op-Kind deadlines for one op's round trip once connected (write the
// request frame, wait for the agent to execute it, read the reply) — see
// agentOpTimeoutFor. A single flat timeout undersold the two shapes of
// work these ops do: install-binary/restore-binary copy a file (slow on a
// loaded disk) and restart-service waits on a service manager command,
// while read-journal/write-config are quick, bounded operations that
// should fail fast rather than hang for minutes on a wedged agent.
const (
	// agentInstallBinaryTimeout and agentRestoreBinaryTimeout bound a
	// local file copy — the slowest ops, generous for a large binary on a
	// slow disk.
	agentInstallBinaryTimeout = 120 * time.Second
	agentRestoreBinaryTimeout = 120 * time.Second
	// agentRestartServiceTimeout bounds a service-manager restart command.
	agentRestartServiceTimeout = 90 * time.Second
	// agentReadJournalTimeout and agentWriteConfigTimeout bound a quick,
	// bounded read/write.
	agentReadJournalTimeout = 30 * time.Second
	agentWriteConfigTimeout = 30 * time.Second
	// defaultAgentOpTimeout is the fallback for any Op.Kind outside the
	// five above — defensive only; ExecOp's switch (privexec.go) is the
	// single authority on which kinds actually exist.
	defaultAgentOpTimeout = 30 * time.Second
)

// agentOpTimeoutFor returns kind's per-op deadline (the agent*Timeout
// constants above).
func agentOpTimeoutFor(kind string) time.Duration {
	switch kind {
	case OpInstallBinary:
		return agentInstallBinaryTimeout
	case OpRestoreBinary:
		return agentRestoreBinaryTimeout
	case OpRestartService:
		return agentRestartServiceTimeout
	case OpReadJournal:
		return agentReadJournalTimeout
	case OpWriteConfig:
		return agentWriteConfigTimeout
	default:
		return defaultAgentOpTimeout
	}
}

// agentClient is a Runner that dials the panel-agent's unix socket once
// per op — no persistent connection or multiplexing, matching the
// protocol's one-request-one-reply-per-connection shape.
type agentClient struct {
	socketPath  string
	dialTimeout time.Duration
}

// NewAgentClient builds a Runner that executes ops by dialing the
// panel-agent unix socket at socketPath, one fresh connection per op,
// each bounded by its Op.Kind's own deadline (agentOpTimeoutFor).
func NewAgentClient(socketPath string) Runner {
	return &agentClient{socketPath: socketPath, dialTimeout: defaultAgentDialTimeout}
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

	deadline := time.Now().Add(agentOpTimeoutFor(op.Kind))
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
