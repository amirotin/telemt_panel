package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
)

const sessionStreamCheckInterval = 5 * time.Second

type sessionStream struct {
	ctx   context.Context
	hash  string
	guard *auth.SessionGuard
	rc    *http.ResponseController
}

func (s *Server) trackSessionStream(w http.ResponseWriter, r *http.Request) (*sessionStream, func(), bool) {
	var ctx context.Context
	var release func()
	var guard *auth.SessionGuard
	hash, _ := auth.SessionIDHashFromContext(r.Context())
	if s.cfg.Auth.Disabled {
		ctx, release = context.WithCancel(r.Context())
	} else {
		guard = s.sessions
		var err error
		ctx, release, err = guard.Track(r.Context(), hash)
		if err != nil {
			auth.WriteError(w, http.StatusUnauthorized, "session_expired", "no valid session")
			return nil, nil, false
		}
	}
	rc := http.NewResponseController(w)
	// A revoke must also interrupt a writer blocked on the transport.
	stop := context.AfterFunc(ctx, func() { _ = rc.SetWriteDeadline(time.Now()) })
	return &sessionStream{ctx: ctx, hash: hash, guard: guard, rc: rc}, func() { stop(); release() }, true
}

func (s *sessionStream) check() error {
	if err := s.ctx.Err(); err != nil {
		return err
	}
	if s.guard != nil {
		return s.guard.Check(s.hash)
	}
	return nil
}

func (s *sessionStream) write(write func() error) error {
	extendSSEWriteDeadline(s.rc)
	if err := s.check(); err != nil {
		return err
	}
	return write()
}
