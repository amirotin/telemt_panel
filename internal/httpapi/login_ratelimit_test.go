package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestLoginRateLimitCountsConcurrentAttempts(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()
	const attempts = 20
	start := make(chan struct{})
	statuses := make(chan int, attempts)
	var ready sync.WaitGroup
	ready.Add(attempts)
	for range attempts {
		go func() {
			ready.Done()
			<-start
			request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"incorrect-test-password"}`))
			request.RemoteAddr = "198.51.100.19:12345"
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			statuses <- response.Code
		}()
	}
	ready.Wait()
	close(start)
	counts := map[int]int{}
	for range attempts {
		counts[<-statuses]++
	}
	if counts[http.StatusUnauthorized] != 5 || counts[http.StatusTooManyRequests] != attempts-5 {
		t.Fatalf("same-IP concurrent login responses = %v; want 5 credential checks and 15 rate limits", counts)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"incorrect"}`))
	request.RemoteAddr = "198.51.100.19:12345"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("next login status = %d; want 429", response.Code)
	}
}
