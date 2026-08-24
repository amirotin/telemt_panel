// Command panel-agent is the minimal root-privileged helper telemt-panel
// dials to execute the five allow-listed host operations (installing a
// binary, restoring one, restarting a service, tailing a journal,
// rewriting a config file) when the panel itself runs unprivileged (spec
// 01-host-matrix.md §Привилегии). It never executes arbitrary commands:
// every request is one of internal/host's fixed Op kinds, and every
// argument is checked against this process's own --allow-binary-dest/
// --allow-config-path/--staging-prefix/--allow-service flags — the
// agent's allow-lists are its final authority regardless of what the
// client sends.
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
	"os/user"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/amirotin/telemt_panel/internal/host"
)

// connDeadline bounds one connection's read-request/write-reply round
// trip, defending against a client that connects but never sends (or
// never reads).
const connDeadline = 30 * time.Second

// staleSocketProbeTimeout bounds the connect-and-close probe run before
// removing an existing socket file, to tell a genuinely stale file (no
// one listening) from a live prior instance.
const staleSocketProbeTimeout = 500 * time.Millisecond

func main() {
	socketPath := flag.String("socket", host.DefaultAgentSocket, "unix socket to listen on")
	socketGroup := flag.String("socket-group", "", "group allowed to connect to the socket, for the unprivileged-panel profile (see run's doc comment); unset keeps the socket root-only")
	var allowBinaryDest, allowConfigPath, allowService stringSliceFlag
	flag.Var(&allowBinaryDest, "allow-binary-dest", "allowed install-binary/restore-binary dest or backup path (repeatable)")
	flag.Var(&allowConfigPath, "allow-config-path", "allowed write-config path (repeatable)")
	stagingPrefix := flag.String("staging-prefix", "", "directory prefix install-binary's staging source must fall under")
	flag.Var(&allowService, "allow-service", "allowed service/container name (repeatable)")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	allow := host.AllowLists{
		BinaryPaths:   []string(allowBinaryDest),
		ConfigPaths:   []string(allowConfigPath),
		StagingPrefix: *stagingPrefix,
		Services:      []string(allowService),
	}
	if err := run(ctx, *socketPath, *socketGroup, allow, logger); err != nil {
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
//
// Two deployment profiles, selected by whether socketGroup is set:
//   - root-only (default, socketGroup == ""): socket dir 0700, socket
//     file 0600, both owned by whatever user runs this process (normally
//     root) — only that user can dial in, which fits a panel that also
//     runs as root (direct mode) or doesn't need the agent at all.
//   - unprivileged-panel (socketGroup set): socket dir 0750, socket file
//     0660, both group-owned by socketGroup — an unprivileged panel
//     process whose user is a member of that group can dial in without
//     running as root itself. install.sh provisioning the group and
//     panel-user membership is out of scope here; this only makes the
//     agent capable of that profile once such provisioning exists.
func run(ctx context.Context, socketPath, socketGroup string, allow host.AllowLists, logger *slog.Logger) error {
	dirMode, sockMode := os.FileMode(0o700), os.FileMode(0o600)
	var gid int
	if socketGroup != "" {
		var err error
		gid, err = lookupGroupID(socketGroup)
		if err != nil {
			return fmt.Errorf("resolve --socket-group %q: %w", socketGroup, err)
		}
		dirMode, sockMode = 0o750, 0o660
	}

	if err := refuseIfAgentAlreadyLive(socketPath); err != nil {
		return err
	}
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale socket: %w", err)
	}
	dir := filepath.Dir(socketPath)
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return fmt.Errorf("create socket dir %q: %w", dir, err)
	}

	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on %q: %w", socketPath, err)
	}
	defer ln.Close()

	if socketGroup != "" {
		if err := os.Chown(dir, -1, gid); err != nil {
			return fmt.Errorf("chown socket dir %q to group %q: %w", dir, socketGroup, err)
		}
		if err := os.Chown(socketPath, -1, gid); err != nil {
			return fmt.Errorf("chown socket %q to group %q: %w", socketPath, socketGroup, err)
		}
	}
	if err := os.Chmod(dir, dirMode); err != nil {
		return fmt.Errorf("chmod socket dir %q: %w", dir, err)
	}
	if err := os.Chmod(socketPath, sockMode); err != nil {
		return fmt.Errorf("chmod socket %q: %w", socketPath, err)
	}

	svcMgr := host.NewServiceManager("auto", host.DefaultProbe(), host.OSCmdRunner)
	logSrc := host.NewLogSource("auto", "", svcMgr.Kind(), host.DefaultProbe(), host.OSCmdRunner, host.OSProcessStarter, host.DefaultLogPollInterval)

	logger.Info("listening", "socket", socketPath, "service_manager", svcMgr.Kind(), "log_source", logSrc.Kind(),
		"allow_binary_dest", len(allow.BinaryPaths), "allow_config_path", len(allow.ConfigPaths),
		"staging_prefix", allow.StagingPrefix, "allow_service", len(allow.Services), "socket_group", socketGroup)

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

// refuseIfAgentAlreadyLive probe-dials socketPath with a short timeout:
// a successful connect means a prior instance is actually listening, in
// which case start-up must refuse rather than remove that live socket
// out from under it (removing it here would silently orphan the running
// instance — its listener stays open on the deleted inode, but nothing
// can dial the now-missing path to reach it). A failed dial (no such
// file, or a file with nothing listening — the ECONNREFUSED case of a
// genuinely stale socket left by an unclean shutdown) is not an error:
// the caller proceeds to remove and recreate it.
func refuseIfAgentAlreadyLive(socketPath string) error {
	conn, err := net.DialTimeout("unix", socketPath, staleSocketProbeTimeout)
	if err != nil {
		return nil
	}
	conn.Close()
	return fmt.Errorf("agent already running at %q", socketPath)
}

// lookupGroupID resolves a group name to its numeric GID.
func lookupGroupID(name string) (int, error) {
	g, err := user.LookupGroup(name)
	if err != nil {
		return 0, err
	}
	gid, err := strconv.Atoi(g.Gid)
	if err != nil {
		return 0, fmt.Errorf("group %q has a non-numeric gid %q", name, g.Gid)
	}
	return gid, nil
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
