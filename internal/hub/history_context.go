package hub

import "context"

func (h *Hub) historyContext() context.Context {
	if h.ctx != nil {
		return h.ctx
	}
	return context.Background()
}
