package hub

import (
	"context"

	"github.com/amirotin/telemt_panel/internal/store"
)

func (h *Hub) historyContext() context.Context {
	if h.ctx != nil {
		return h.ctx
	}
	return context.Background()
}

func trafficSummariesContext(ctx context.Context, st store.HistoryStore) (map[string]store.UserTrafficSummary, error) {
	read, err := st.BeginTrafficRead(ctx)
	if err != nil {
		return nil, err
	}
	summaries, err := read.Summaries()
	closeErr := read.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return summaries, nil
}
