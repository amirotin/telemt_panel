package geography

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/netip"
	"strings"
	"unicode/utf8"
)

const serverLocationKey = "geography.server_location"

// ServerLocationConfig is an explicit, panel-owned Telemt position setting.
type ServerLocationConfig struct {
	Mode      string   `json:"mode"`
	Label     string   `json:"label"`
	PublicIP  *string  `json:"public_ip"`
	Latitude  *float64 `json:"latitude"`
	Longitude *float64 `json:"longitude"`
}

// Settings holds the persisted desired position, including its private input address.
type Settings struct {
	ServerLocation ServerLocationConfig `json:"server_location"`
}

func validateServerLocation(c ServerLocationConfig) (ServerLocationConfig, error) {
	if !utf8.ValidString(c.Label) || utf8.RuneCountInString(c.Label) > 80 {
		return c, ErrBadRequest
	}
	switch c.Mode {
	case "hidden":
		if c.PublicIP != nil || c.Latitude != nil || c.Longitude != nil {
			return c, ErrBadRequest
		}
	case "manual":
		if c.PublicIP != nil || c.Latitude == nil || c.Longitude == nil || math.IsNaN(*c.Latitude) || math.IsNaN(*c.Longitude) || math.IsInf(*c.Latitude, 0) || math.IsInf(*c.Longitude, 0) || math.Abs(*c.Latitude) > 90 || math.Abs(*c.Longitude) > 180 {
			return c, ErrBadRequest
		}
	case "ip":
		if c.PublicIP == nil || c.Latitude != nil || c.Longitude != nil {
			return c, ErrBadRequest
		}
		addr, err := netip.ParseAddr(*c.PublicIP)
		if err != nil || addr.Zone() != "" || !addr.IsGlobalUnicast() || isPrivate(addr) {
			return c, ErrBadRequest
		}
		ip := addr.Unmap().String()
		c.PublicIP = &ip
	default:
		return c, ErrBadRequest
	}
	return cloneConfig(c), nil
}

func cloneConfig(c ServerLocationConfig) ServerLocationConfig {
	if c.PublicIP != nil {
		v := *c.PublicIP
		c.PublicIP = &v
	}
	if c.Latitude != nil {
		v := *c.Latitude
		c.Latitude = &v
	}
	if c.Longitude != nil {
		v := *c.Longitude
		c.Longitude = &v
	}
	return c
}

func (s *Service) restoreSettings() ServerLocationConfig {
	hidden := ServerLocationConfig{Mode: "hidden"}
	if s.deps.State == nil {
		return hidden
	}
	raw, ok, err := s.deps.State.GetSetting(serverLocationKey)
	if err != nil {
		slog.Warn("geography: stored server location ignored", "err", "setting_read_failed")
		return hidden
	}
	if !ok {
		return hidden
	}
	d := json.NewDecoder(strings.NewReader(raw))
	d.DisallowUnknownFields()
	var c ServerLocationConfig
	if err = d.Decode(&c); err == nil {
		var rest any
		if d.Decode(&rest) != io.EOF {
			err = ErrBadRequest
		}
	}
	if err == nil {
		c, err = validateServerLocation(c)
	}
	if err != nil {
		// Decoder errors can include private values embedded in unknown field names.
		slog.Warn("geography: stored server location ignored", "err", "invalid_configuration")
		return hidden
	}
	return c
}

// Settings returns an owned copy of the persisted position configuration.
func (s *Service) Settings(ctx context.Context) (Settings, error) {
	if err := ctx.Err(); err != nil {
		return Settings{}, err
	}
	version := s.settingsSnapshot.Load()
	return Settings{ServerLocation: cloneConfig(version.config)}, nil
}

// PutSettings persists before publishing, preserving the old config and epoch on failure.
func (s *Service) PutSettings(ctx context.Context, c ServerLocationConfig) (Settings, error) {
	c, err := validateServerLocation(c)
	if err != nil {
		return Settings{}, err
	}
	if err = ctx.Err(); err != nil {
		return Settings{}, err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return Settings{}, err
	}
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	if s.deps.State == nil {
		return Settings{}, ErrSourceChanged
	}
	if err = s.deps.State.SetSetting(serverLocationKey, string(raw)); err != nil {
		return Settings{}, err
	}
	s.settingsSnapshot.Store(&settingsVersion{config: c})
	s.settingsEpoch.Add(1)
	return Settings{ServerLocation: cloneConfig(c)}, nil
}
