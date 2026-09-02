//go:build lite

package store

func init() {
	RegisterUnavailable("sqlite", "this build has no sqlite driver — install the full variant (telemt-panel, not telemt-panel-lite)")
	RegisterUnavailable("postgres", "this build has no postgres driver — install the full variant (telemt-panel, not telemt-panel-lite)")
	RegisterUnavailable("mysql", "this build has no mysql driver — install the full variant (telemt-panel, not telemt-panel-lite)")
}
