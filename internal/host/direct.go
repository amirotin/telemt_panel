package host

import "context"

// directRunner executes privileged ops in-process — the router profile
// (already root) or an operator's explicit "direct" mode choice. It runs
// every op through ExecOp, the exact same validation and execution code
// cmd/panel-agent's connection handler calls, so the two paths can't
// drift in what they accept or how they run it.
type directRunner struct {
	allow  AllowLists
	svcMgr ServiceManager
	logSrc LogSource
}

// NewDirectRunner builds a Runner that executes ops in-process, validating
// every arg against allow and delegating restart-service/read-journal to
// svcMgr/logSrc.
func NewDirectRunner(allow AllowLists, svcMgr ServiceManager, logSrc LogSource) Runner {
	return &directRunner{allow: allow, svcMgr: svcMgr, logSrc: logSrc}
}

// Run implements Runner.
func (r *directRunner) Run(ctx context.Context, op Op) (Output, error) {
	return ExecOp(ctx, op, r.allow, r.svcMgr, r.logSrc)
}
