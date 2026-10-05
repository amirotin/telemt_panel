package host

import (
	"errors"
)

// PrivilegedPolicy fixes the only writable installation paths authorized by root.
type PrivilegedPolicy struct {
	Version     int               `json:"version"`
	HelperPath  string            `json:"helper_path"`
	StagingRoot string            `json:"staging_root"`
	Binaries    map[string]string `json:"binaries"`
}

// DefaultPrivilegedPolicyPath is separate from runtime-writable configuration.
const DefaultPrivilegedPolicyPath = "/etc/telemt-panel-privileged/policy.json"

// EntwarePrivilegedPolicyPath locates the protected policy on /opt installations.
const EntwarePrivilegedPolicyPath = "/opt/etc/telemt-panel-privileged/policy.json"

// PrivilegedPolicyVersion requires a helper independent of replaceable targets.
const PrivilegedPolicyVersion = 2

// DefaultPrivilegedHelperPath is the installer-owned stable native helper.
const DefaultPrivilegedHelperPath = "/usr/local/libexec/telemt-panel-privileged"

// EntwarePrivilegedHelperPath is the stable helper for /opt installations.
const EntwarePrivilegedHelperPath = "/opt/libexec/telemt-panel-privileged"

// ErrInstallInProgress rejects a concurrent privileged installation for a target.
var ErrInstallInProgress = errors.New("privileged target installation in progress")
