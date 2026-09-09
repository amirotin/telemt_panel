// Package userprojection builds the fields shared by users REST responses and
// the Hub users topic.
package userprojection

import (
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// User contains the fields common to users REST responses and the Hub users
// topic.
type User struct {
	telemt.UserInfo
	Traffic   *Traffic             `json:"traffic,omitempty"`
	IPHistory *store.UserIPSummary `json:"ip_history,omitempty"`
}

// Traffic contains the panel-owned traffic fields exposed with a user.
type Traffic struct {
	ObservedTotalBytes     int64                       `json:"observed_total_bytes"`
	CurrentMonthBytes      int64                       `json:"current_month_bytes"`
	MonthKey               int                         `json:"month_key"`
	ObservedSinceEpochSecs int64                       `json:"observed_since_epoch_secs"`
	LastActivityEpochSecs  int64                       `json:"last_activity_epoch_secs"`
	Continuity             store.UserTrafficContinuity `json:"continuity"`
}

// Build returns a user projection enriched with any summaries available for
// the user's username.
func Build(user telemt.UserInfo, traffic map[string]store.UserTrafficSummary, ips map[string]store.UserIPSummary) User {
	result := User{UserInfo: user}
	if summary, ok := traffic[user.Username]; ok {
		result.Traffic = &Traffic{
			ObservedTotalBytes:     summary.ObservedTotalBytes,
			CurrentMonthBytes:      summary.CurrentMonthBytes,
			MonthKey:               summary.MonthKey,
			ObservedSinceEpochSecs: summary.ObservedSinceEpochSecs,
			LastActivityEpochSecs:  summary.LastActivityEpochSecs,
			Continuity:             summary.Continuity,
		}
	}
	if summary, ok := ips[user.Username]; ok {
		result.IPHistory = &summary
	}
	return result
}
