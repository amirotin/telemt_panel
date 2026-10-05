package httpapi

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func panelLimitsFixture(t *testing.T, h2 bool) *httptest.Server {
	t.Helper()
	s := newTestServer(t)
	server := httptest.NewUnstartedServer(s.Handler())
	server.Config = s.panelHTTPServer(nil)
	if h2 {
		server.EnableHTTP2 = true
		server.StartTLS()
	} else {
		server.Start()
	}
	t.Cleanup(server.Close)
	return server
}

func TestPanelHeaderLimitNetworkProtocols(t *testing.T) {
	for _, h2 := range []bool{false, true} {
		t.Run(map[bool]string{false: "http1", true: "http2"}[h2], func(t *testing.T) {
			server := panelLimitsFixture(t, h2)
			r, _ := http.NewRequest(http.MethodGet, server.URL+"/api/auth/methods", nil)
			r.Header.Set("X-Audit", strings.Repeat("s", 32<<10))
			response, err := server.Client().Do(r)
			if err != nil {
				if h2 && (strings.Contains(err.Error(), "header list") || strings.Contains(err.Error(), "ErrCode=COMPRESSION_ERROR")) {
					return
				}
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, _ := io.ReadAll(response.Body)
			if response.StatusCode != http.StatusRequestHeaderFieldsTooLarge {
				t.Fatalf("large header status=%d body=%s", response.StatusCode, body)
			}
			if strings.Contains(string(body), strings.Repeat("s", 100)) {
				t.Fatal("rejection disclosed header payload")
			}
		})
	}
}

func TestPanelSlowHeaderDeadline(t *testing.T) {
	server := panelLimitsFixture(t, false)
	conn, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, "GET /api/auth/methods HTTP/1.1\r\nHost: localhost\r\nX-Incomplete: "); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(7 * time.Second))
	_, err = bufio.NewReader(conn).ReadString('\n')
	if timed, ok := err.(net.Error); ok && timed.Timeout() {
		t.Fatal("incomplete header survived5s listener deadline")
	}
}

func TestPanelHeaderLimitAcceptsNormalCookies(t *testing.T) {
	server := panelLimitsFixture(t, true)
	r, _ := http.NewRequest(http.MethodGet, server.URL+"/api/auth/methods", nil)
	r.Header.Set("Cookie", "panel_session="+strings.Repeat("a", 43))
	r.Header.Set("User-Agent", strings.Repeat("x", 4096))
	response, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("normal headers status=%d", response.StatusCode)
	}
}
