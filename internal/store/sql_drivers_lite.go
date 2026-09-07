//go:build lite

package store

func init() {
	RegisterUnavailable("sqlite", "this build has no sqlite driver — install the full variant (telemt-panel, not telemt-panel-lite)")
}
