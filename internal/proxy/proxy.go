package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

type TelemtProxy struct {
	handler    http.Handler
	targetURL  string
	authHeader string
}

type SystemInfo struct {
	ConfigPath string `json:"config_path"`
	ConfigHash string `json:"config_hash"`
}

func NewTelemtProxy(targetURL string, authHeader string) (*TelemtProxy, error) {
	target, err := url.Parse(targetURL)
	if err != nil {
		return nil, err
	}

	tp := &TelemtProxy{
		targetURL:  targetURL,
		authHeader: authHeader,
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.URL.Path = strings.TrimPrefix(r.Out.URL.Path, "/api/telemt")
			if r.Out.URL.Path == "" {
				r.Out.URL.Path = "/"
			}
			r.Out.Host = target.Host

			if authHeader != "" {
				r.Out.Header.Set("Authorization", authHeader)
			}

			r.Out.Header.Del("Cookie")
		},
		ModifyResponse: func(resp *http.Response) error {
			// If telemt returns 401, it means auth_header in panel config
			// is wrong — NOT that the panel session expired. Convert to 502
			// so the frontend doesn't redirect to login in a loop.
			if resp.StatusCode == http.StatusUnauthorized {
				resp.Body.Close()
				body := `{"ok":false,"error":{"code":"telemt_auth_failed","message":"telemt rejected authorization – check auth_header in panel config"}}`
				resp.StatusCode = http.StatusBadGateway
				resp.Status = "502 Bad Gateway"
				resp.Body = io.NopCloser(strings.NewReader(body))
				resp.ContentLength = int64(len(body))
				resp.Header.Set("Content-Type", "application/json")
				return nil
			}

			// Touch config after successful mutating requests to /v1/users
			// so Telemt picks up changes via hot-reload
			if resp.StatusCode >= 200 && resp.StatusCode < 300 &&
				strings.Contains(resp.Request.URL.Path, "/v1/users") &&
				resp.Request.Method != http.MethodGet {
				go tp.touchConfig()
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			w.Write([]byte(`{"ok":false,"error":{"code":"bad_gateway","message":"telemt API unavailable"}}`))
		},
	}

	tp.handler = proxy
	return tp, nil
}

// touchConfig fetches the config path from Telemt and touches the file
// to trigger hot-reload after user mutations via API.
func (p *TelemtProxy) touchConfig() {
	info, err := p.GetSystemInfo()
	if err != nil {
		log.Printf("[proxy] touch config: failed to get system info: %v", err)
		return
	}
	now := time.Now()
	if err := os.Chtimes(info.ConfigPath, now, now); err != nil {
		log.Printf("[proxy] touch config %s: %v", info.ConfigPath, err)
	}
}

func (p *TelemtProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.handler.ServeHTTP(w, r)
}

// ConnectivityCheck makes a test request to telemt /v1/health and returns
// diagnostic info: URL, whether auth is configured, HTTP status, response body.
func (p *TelemtProxy) ConnectivityCheck() map[string]interface{} {
	result := map[string]interface{}{
		"telemt_url":    p.targetURL,
		"auth_configured": p.authHeader != "",
	}

	if p.authHeader != "" {
		// Show masked value: first 4 chars + "***" + last 2 chars
		h := p.authHeader
		if len(h) > 8 {
			result["auth_header_preview"] = h[:4] + "***" + h[len(h)-2:]
		} else {
			result["auth_header_preview"] = "***"
		}
		result["auth_header_length"] = len(h)
	}

	url := p.targetURL + "/v1/health"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		result["status"] = "error"
		result["error"] = fmt.Sprintf("failed to create request: %v", err)
		return result
	}

	if p.authHeader != "" {
		req.Header.Set("Authorization", p.authHeader)
	}

	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse // don't follow redirects
		},
	}

	resp, err := client.Do(req)
	if err != nil {
		result["status"] = "unreachable"
		result["error"] = err.Error()
		return result
	}
	defer resp.Body.Close()

	result["http_status"] = resp.StatusCode
	result["http_status_text"] = resp.Status

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	result["response_body"] = string(body)

	if resp.StatusCode == 200 {
		result["status"] = "ok"
	} else if resp.StatusCode == 401 {
		result["status"] = "auth_rejected"
	} else if resp.StatusCode == 403 {
		result["status"] = "ip_not_whitelisted"
	} else {
		result["status"] = "error"
	}

	return result
}

func (p *TelemtProxy) GetSystemInfo() (*SystemInfo, error) {
	req, err := http.NewRequest("GET", p.targetURL+"/v1/system/info", nil)
	if err != nil {
		return nil, err
	}

	if p.authHeader != "" {
		req.Header.Set("Authorization", p.authHeader)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("telemt API returned status %d", resp.StatusCode)
	}

	var result struct {
		Data SystemInfo `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}

	return &result.Data, nil
}
