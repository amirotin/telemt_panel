package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// WorkerHealthProbe validates readiness and the exact requested runtime version.
type WorkerHealthProbe struct {
	PanelURL string
	Telemt   *telemt.Client
	Client   *http.Client
	Timeout  time.Duration
	Interval time.Duration
}

// Check requires two consecutive healthy responses with the requested version.
func (p *WorkerHealthProbe) Check(ctx context.Context, target, version string) error {
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = defaultHealthTimeout
	}
	interval := p.Interval
	if interval <= 0 {
		interval = time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var last error
	consecutive := 0
	for {
		var current string
		var err error
		if target == TargetPanel {
			current, err = p.panelVersion(ctx)
		} else if target == TargetTelemt {
			current, err = p.telemtVersion(ctx)
		} else {
			return ErrUnknownTarget
		}
		if err == nil {
			if strings.TrimPrefix(current, "v") == strings.TrimPrefix(version, "v") && version != "" {
				consecutive++
				if consecutive >= 2 {
					return nil
				}
				err = errors.New("waiting for a second healthy response")
			} else {
				consecutive = 0
				err = fmt.Errorf("running version %q differs from requested %q", current, version)
			}
		} else {
			consecutive = 0
		}
		last = err
		select {
		case <-ctx.Done():
			return errors.Join(ctx.Err(), last)
		case <-time.After(interval):
		}
	}
}

func (p *WorkerHealthProbe) panelVersion(ctx context.Context) (string, error) {
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.PanelURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("panel readiness HTTP %d", resp.StatusCode)
	}
	var result struct {
		Status  string `json:"status"`
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 65536)).Decode(&result); err != nil {
		return "", err
	}
	if result.Status != "ok" {
		return "", fmt.Errorf("panel readiness status %q", result.Status)
	}
	return result.Version, nil
}

func (p *WorkerHealthProbe) telemtVersion(ctx context.Context) (string, error) {
	if p.Telemt == nil {
		return "", errors.New("Telemt readiness client missing")
	}
	health, err := p.Telemt.Health(ctx)
	if err != nil {
		return "", err
	}
	if health.Status != "ok" {
		return "", fmt.Errorf("Telemt health status %q", health.Status)
	}
	ready, err := p.Telemt.Ready(ctx)
	if err != nil {
		var apiError *telemt.APIError
		if !errors.As(err, &apiError) || apiError.Status != http.StatusNotFound {
			return "", err
		}
	} else if !ready.Ready {
		return "", errors.New("Telemt is not ready")
	}
	info, err := p.Telemt.SystemInfo(ctx)
	if err != nil {
		return "", err
	}
	return info.Version, nil
}
