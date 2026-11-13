package telemt

import "encoding/json"

// MTProtoListenerState reports configured, absent, or unknown MTProto availability.
// Only an explicit nonempty all-WEB listener list proves MTProto is absent.
func MTProtoListenerState(sections map[string]json.RawMessage) string {
	var server map[string]json.RawMessage
	if json.Unmarshal(sections["server"], &server) != nil || server == nil {
		return "unknown"
	}
	rawListeners, exists := server["listeners"]
	if !exists {
		var port int
		if json.Unmarshal(server["port"], &port) == nil && port > 0 && port <= 65535 {
			return "configured"
		}
		return "unknown"
	}
	var listeners []map[string]json.RawMessage
	if json.Unmarshal(rawListeners, &listeners) != nil || len(listeners) == 0 {
		return "unknown"
	}
	state := "absent"
	for _, listener := range listeners {
		if listener == nil {
			return "unknown"
		}
		rawTransport, exists := listener["transport"]
		if !exists {
			state = "configured"
			continue
		}
		var transport string
		if json.Unmarshal(rawTransport, &transport) != nil {
			return "unknown"
		}
		switch transport {
		case "mtproxy":
			state = "configured"
		case "web":
		default:
			return "unknown"
		}
	}
	return state
}
