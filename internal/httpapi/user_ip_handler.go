package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
)

type userIPHistoryItem struct {
	store.UserIPRecord
	ActiveNow *bool `json:"active_now"`
}
type userIPHistoryView struct {
	ActiveNowCount *int                   `json:"active_now_count"`
	Items          []userIPHistoryItem    `json:"items"`
	Total          int64                  `json:"total"`
	Matched        int64                  `json:"matched"`
	New            int64                  `json:"new"`
	NextCursor     string                 `json:"next_cursor"`
	Range          string                 `json:"range"`
	RetentionDays  int                    `json:"retention_days"`
	Durable        bool                   `json:"durable"`
	Collection     store.UserIPCollection `json:"collection"`
	Source         hub.UserIPSourceStatus `json:"source"`
}
type userIPCursor struct {
	User   string `json:"u"`
	Range  string `json:"r"`
	Family int    `json:"f"`
	Search string `json:"q"`
	Last   int64  `json:"t"`
	IP     string `json:"i"`
}

func userIPRequestQuery(r *http.Request, now int64) (store.UserIPQuery, string, error) {
	v := r.URL.Query()
	span := v.Get("range")
	if span == "" {
		span = "30d"
	}
	var seconds int64
	switch span {
	case "24h":
		seconds = 86400
	case "7d":
		seconds = 7 * 86400
	case "30d":
		seconds = 30 * 86400
	case "all":
	default:
		return store.UserIPQuery{}, "", errors.New("invalid range")
	}
	q := store.UserIPQuery{Username: r.PathValue("username"), Now: now, Limit: 50, Search: strings.ToLower(strings.TrimSpace(v.Get("q")))}
	if seconds > 0 {
		q.From = now - seconds
	}
	if q.Username == "" || len(q.Search) > 64 {
		return q, span, errors.New("invalid user or search")
	}
	if ip, _, err := store.NormalizeUserIP(q.Search); err == nil {
		q.Search = ip
	}
	if v.Has("limit") {
		n, err := strconv.Atoi(v.Get("limit"))
		if err != nil || n < 1 || n > 200 {
			return q, span, errors.New("limit must be between 1 and 200")
		}
		q.Limit = n
	}
	switch v.Get("family") {
	case "", "all":
	case "4":
		q.Family = 4
	case "6":
		q.Family = 6
	default:
		return q, span, errors.New("invalid IP family")
	}
	if cursor := v.Get("cursor"); cursor != "" {
		if len(cursor) > 2048 {
			return q, span, errors.New("invalid cursor")
		}
		data, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil {
			return q, span, errors.New("invalid cursor")
		}
		var c userIPCursor
		if err := json.Unmarshal(data, &c); err != nil || c.User != q.Username || c.Range != span || c.Family != q.Family || c.Search != q.Search || c.Last <= 0 {
			return q, span, errors.New("cursor does not match query")
		}
		if ip, _, err := store.NormalizeUserIP(c.IP); err != nil || ip != c.IP {
			return q, span, errors.New("invalid cursor IP")
		}
		q.Before, q.AfterIP = c.Last, c.IP
	}
	return q, span, nil
}

func (s *Server) handleGetUserIPHistory(w http.ResponseWriter, r *http.Request) {
	q, span, err := userIPRequestQuery(r, time.Now().Unix())
	if err != nil {
		auth.WriteError(w, 400, "bad_request", err.Error())
		return
	}
	page, err := s.st.UserIPHistory(q)
	if err != nil {
		auth.WriteError(w, 500, "internal_error", "could not read IP history")
		return
	}
	collection, err := s.st.UserIPCollectionState()
	if err != nil {
		auth.WriteError(w, 500, "internal_error", "could not read IP collection state")
		return
	}
	result := userIPHistoryView{Items: make([]userIPHistoryItem, 0, len(page.Items)), Total: page.Total, Matched: page.Matched, New: page.New, Range: span, RetentionDays: int(s.st.UserIPRetention() / (24 * time.Hour)), Durable: s.st.Info().Durable, Collection: collection, Source: hub.UserIPSourceStatus{State: "unavailable"}}
	if s.hub != nil {
		result.Source = s.hub.UserIPSourceStatus()
		result.ActiveNowCount = s.hub.UserIPActiveCount(q.Username)
	}
	for _, r := range page.Items {
		item := userIPHistoryItem{UserIPRecord: r}
		if s.hub != nil {
			item.ActiveNow = s.hub.UserIPLive(q.Username, r.IP)
		}
		result.Items = append(result.Items, item)
	}
	if page.HasMore {
		last := page.Items[len(page.Items)-1]
		data, _ := json.Marshal(userIPCursor{User: q.Username, Range: span, Family: q.Family, Search: q.Search, Last: last.Last, IP: last.IP})
		result.NextCursor = base64.RawURLEncoding.EncodeToString(data)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, result)
}

func (s *Server) handleResetUserIPHistory(w http.ResponseWriter, r *http.Request) {
	if !decodeDestructiveConfirmation(w, r, "IP history reset requires explicit confirmation") {
		return
	}
	username := r.PathValue("username")
	if username == "" {
		auth.WriteError(w, 400, "bad_request", "username is required")
		return
	}
	if err := s.resetUserIPHistory(username); err != nil {
		auth.WriteError(w, 500, "internal_error", "could not reset IP history")
		return
	}
	s.appendAudit(r, "user.ip_history_reset", username, "")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) resetUserIPHistory(username string) error {
	if s.hub != nil {
		return s.hub.ResetUserIPHistory(username)
	}
	return s.st.ResetUserIPHistory(username)
}
