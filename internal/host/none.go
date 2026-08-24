package host

import "context"

// None is the fallback ServiceManager for hosts where no init system was
// detected and none was configured. It cannot restart or query anything;
// Caps() carries a generic manual-restart hint since it has no init
// system's command to offer.
type None struct{}

// NewNone builds a None ServiceManager.
func NewNone() *None { return &None{} }

// Kind implements ServiceManager.
func (n *None) Kind() string { return KindNone }

// Status implements ServiceManager. Always unknown: Caps().CanStatus is
// false.
func (n *None) Status(ctx context.Context, service string) (ServiceStatus, error) {
	return StatusUnknown, nil
}

// Restart implements ServiceManager. Always fails: Caps().CanRestart is
// false.
func (n *None) Restart(ctx context.Context, service string) error {
	return ErrManualRestartRequired
}

// Caps implements ServiceManager.
func (n *None) Caps() ServiceCaps {
	return ServiceCaps{
		CanRestart:        false,
		CanStatus:         false,
		ManualRestartHint: "no init system detected on this host; restart the service manually",
	}
}

// NoneLog is the fallback LogSource for hosts where no log source was
// detected or configured. Tail/Stream always fail; Caps().CanTail/
// CanStream are both false, so httpapi is expected to 501 before ever
// calling either — ErrLogUnavailable is a defensive fallback, not the
// primary signal, the same way None's Restart backs ServiceCaps.
type NoneLog struct{}

// NewNoneLog builds a NoneLog LogSource.
func NewNoneLog() *NoneLog { return &NoneLog{} }

// Kind implements LogSource.
func (n *NoneLog) Kind() string { return LogKindNone }

// Tail implements LogSource. Always fails: Caps().CanTail is false.
func (n *NoneLog) Tail(ctx context.Context, service string, lines int) ([]LogLine, error) {
	return nil, ErrLogUnavailable
}

// Stream implements LogSource. Always fails: Caps().CanStream is false.
func (n *NoneLog) Stream(ctx context.Context, service string) (<-chan LogLine, error) {
	return nil, ErrLogUnavailable
}

// Caps implements LogSource.
func (n *NoneLog) Caps() LogCaps {
	return LogCaps{CanTail: false, CanStream: false}
}
