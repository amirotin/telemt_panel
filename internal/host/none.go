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
