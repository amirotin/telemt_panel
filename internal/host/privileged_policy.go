package host

import (
	"errors"
)

// PrivilegedPolicy fixes the only writable installation paths authorized by root.
type PrivilegedPolicy struct {
	Version     int               `json:"version"`
	StagingRoot string            `json:"staging_root"`
	Binaries    map[string]string `json:"binaries"`
}

// DefaultPrivilegedPolicyPath is separate from runtime-writable configuration.
const DefaultPrivilegedPolicyPath = "/etc/telemt-panel-privileged/policy.json"

// EntwarePrivilegedPolicyPath locates the protected policy on /opt installations.
const EntwarePrivilegedPolicyPath = "/opt/etc/telemt-panel-privileged/policy.json"

// ErrInstallInProgress rejects a concurrent privileged installation for a target.
var ErrInstallInProgress = errors.New("privileged target installation in progress")
