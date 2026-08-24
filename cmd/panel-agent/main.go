// Command panel-agent is the minimal root-privileged helper telemt-panel
// dials to execute the five allow-listed host operations (installing a
// binary, restoring one, restarting a service, tailing a journal,
// rewriting a config file) when the panel itself runs unprivileged (spec
// 01-host-matrix.md §Привилегии). It never executes arbitrary commands:
// every request is one of internal/host's fixed Op kinds, and every
// argument is checked against this process's own --allow-dest/
// --allow-service flags — the agent's allow-lists are its final
// authority regardless of what the client sends.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/amirotin/telemt_panel/internal/host"
)

// connDeadline bounds one connection's read-request/write-reply round
// trip, defending against a client that connects but never sends (or
// never reads).
const connDeadline = 30 * time.Second

func main() {
	socketPath := flag.String("socket", host.DefaultAgentSocket, "unix socket to listen on")
	var allowDest, allowService stringSliceFlag
	flag.Var(&allowDest, "allow-dest", "allowed destination/backup/config path (repeatable)")
	flag.Var(&allowService, "allow-service", "allowed service/container name (repeatable)")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, *socketPath, []string(allowDest), []string(allowService), logger); err != nil {
		logger.Error("panel-agent exiting", "error", err)
		os.Exit(1)
	}
}

// stringSliceFlag implements flag.Value to collect a flag repeated on the
// command line (flag.String only keeps the last occurrence).
type stringSliceFlag []string

func (s *stringSliceFlag) String() string { return fmt.Sprint([]string(*s)) }

func (s *stringSliceFlag) Set(v string) error {
	*s = append(*s, v)
	return nil
}

// run listens on socketPath and serves connections until ctx is
// canceled, then waits for in-flight connections to finish before
// returning — the graceful-shutdown half of the brief's SIGTERM
// requirement (main wires SIGTERM into ctx via signal.NotifyContext).
func run(ctx context.Context, socketPath string, allowDest, allowService []string, logger *slog.Logger) error {
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale socket: %w", err)
	}
	dir := filepath.Dir(socketPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create socket dir %q: %w", dir, err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("chmod socket dir %q: %w", dir, err)
	}

	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on %q: %w", socketPath, err)
	}
	defer ln.Close()
	if err := os.Chmod(socketPath, 0o600); err != nil {
		return fmt.Errorf("chmod socket %q: %w", socketPath, err)
	}

	svcMgr := host.NewServiceManager("auto", host.DefaultProbe(), host.OSCmdRunner)
	logSrc := host.NewLogSource("auto", "", svcMgr.Kind(), host.DefaultProbe(), host.OSCmdRunner, host.OSProcessStarter, host.DefaultLogPollInterval)
	allow := host.AllowLists{Paths: allowDest, Services: allowService}

	logger.Info("listening", "socket", socketPath, "service_manager", svcMgr.Kind(), "log_source", logSrc.Kind(),
		"allow_dest", len(allowDest), "allow_service", len(allowService))

	go func() {
		<-ctx.Done()
		ln.Close()
	}()

	var wg sync.WaitGroup
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				break // deliberate shutdown, not a real accept failure
			}
			logger.Warn("accept", "error", err)
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			handleConn(ctx, conn, allow, svcMgr, logSrc, logger)
		}()
	}
	wg.Wait()
	return nil
}

// handleConn serves exactly one request/reply round trip: read one
// framed Op, validate and execute it via host.ExecOp, write one framed
// AgentResponse. A frame-level error (bad length prefix, I/O failure)
// just closes the connection — there is no well-formed Op to reply
// about. A well-framed-but-invalid request (bad JSON, disallowed
// kind/dest/service) gets a proper {ok:false, error:...} reply, since the
// client is owed a reason.
func handleConn(ctx context.Context, conn net.Conn, allow host.AllowLists, svcMgr host.ServiceManager, logSrc host.LogSource, logger *slog.Logger) {
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(connDeadline)); err != nil {
		logger.Warn("set connection deadline", "error", err)
		return
	}

	payload, err := host.ReadFrame(conn)
	if err != nil {
		logger.Warn("read request frame", "error", err)
		return
	}

	var op host.Op
	if err := json.Unmarshal(payload, &op); err != nil {
		reply(conn, logger, host.AgentResponse{OK: false, Error: fmt.Sprintf("invalid request: %v", err)})
		return
	}

	// Audit every op by kind + its one "primary" arg — the identity of
	// what was touched, never file content (write-config's "content") or
	// full arg maps.
	logger.Info("op", "kind", op.Kind, "arg", primaryArg(op))

	out, err := host.ExecOp(ctx, op, allow, svcMgr, logSrc)
	if err != nil {
		reply(conn, logger, host.AgentResponse{OK: false, Error: err.Error()})
		return
	}
	reply(conn, logger, host.AgentResponse{OK: true, Stdout: out.Stdout})
}

// primaryArg picks the one op argument worth naming in the audit log:
// the thing being installed/restored/restarted/tailed/rewritten. Never
// "content" or "staging"/"backup" (a source path, not the protected
// target).
func primaryArg(op host.Op) string {
	switch op.Kind {
	case host.OpInstallBinary, host.OpRestoreBinary:
		return op.Args[host.ArgDest]
	case host.OpRestartService, host.OpReadJournal:
		return op.Args[host.ArgService]
	case host.OpWriteConfig:
		return op.Args[host.ArgPath]
	default:
		return ""
	}
}

// reply marshals and writes resp as one framed response, logging (not
// failing the caller, which has nothing left to do) if the write itself
// fails.
func reply(conn net.Conn, logger *slog.Logger, resp host.AgentResponse) {
	payload, err := json.Marshal(resp)
	if err != nil {
		logger.Error("marshal response", "error", err)
		return
	}
	if err := host.WriteFrame(conn, payload); err != nil {
		logger.Warn("write response frame", "error", err)
	}
}
