package telemt

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

const testUsersBodyLimit = 32 * 1024 * 1024

func TestUsersResponseLimitAcceptsExpandedNativeList(t *testing.T) {
	const payload = `{"ok":true,"data":[{"username":"alice","enabled":true}]}`
	for _, length := range []int64{-1, testUpstreamBodyLimit + 1, testUsersBodyLimit} {
		t.Run(fmt.Sprint(length), func(t *testing.T) {
			size := testUpstreamBodyLimit + 1
			if length == testUsersBodyLimit {
				size = testUsersBodyLimit
			}
			c, body := newBodyLimitTestClient(paddedUpstreamBody(payload, size), length, http.StatusOK)
			users, err := c.Users(context.Background())
			if err != nil || len(users) != 1 || users[0].Username != "alice" {
				t.Fatalf("expanded users list = %v, error = %v", users, err)
			}
			if body.bytesRead != size || !body.closed {
				t.Fatalf("read %d bytes, closed %v; want %d and closed", body.bytesRead, body.closed, size)
			}
		})
	}
}

func TestUsersResponseLimitScopeAndBoundaries(t *testing.T) {
	for _, tc := range []struct {
		method string
		path   string
		limit  int
	}{
		{http.MethodGet, "/v1/users", testUsersBodyLimit},
		{http.MethodGet, "/v1/stats/users", testUsersBodyLimit},
		{http.MethodPost, "/v1/users", testUpstreamBodyLimit},
		{http.MethodPatch, "/v1/users/alice", testUpstreamBodyLimit},
		{http.MethodGet, "/v1/users/alice", testUpstreamBodyLimit},
		{http.MethodGet, "/v1/users/", testUpstreamBodyLimit},
		{http.MethodGet, "/v1/users?unexpected=1", testUpstreamBodyLimit},
		{http.MethodGet, "/v1/stats/users/", testUpstreamBodyLimit},
		{http.MethodGet, "/v1/system/info", testUpstreamBodyLimit},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			for _, length := range []int64{-1, 1, int64(tc.limit + 1)} {
				t.Run(fmt.Sprint(length), func(t *testing.T) {
					c, body := newBodyLimitTestClient(testWhitespaceReader{}, length, http.StatusOK)
					_, _, err := c.requestStatus(context.Background(), tc.method, tc.path, nil, "")
					if !errors.Is(err, ErrResponseTooLarge) {
						t.Fatalf("error = %v, want ErrResponseTooLarge", err)
					}
					wantRead := tc.limit + 1
					if length > int64(tc.limit) {
						wantRead = 0
					}
					if body.bytesRead != wantRead || !body.closed {
						t.Fatalf("read %d bytes, closed %v; want %d and closed", body.bytesRead, body.closed, wantRead)
					}
					wantLimit := fmt.Sprintf("%d MiB", tc.limit/1024/1024)
					if !strings.Contains(err.Error(), wantLimit) || !strings.Contains(DiagnoseError(err).Message, wantLimit) {
						t.Fatalf("error %q and diagnostic %+v must report active limit %s", err, DiagnoseError(err), wantLimit)
					}
					if DiagnoseError(err).Code != "telemt_response_too_large" {
						t.Fatalf("diagnostic code = %q", DiagnoseError(err).Code)
					}
				})
			}
		})
	}
}

func TestUsersResponseLimitAliasAcceptsExpandedList(t *testing.T) {
	const payload = `{"ok":true,"data":[{"username":"alice"}]}`
	c, _ := newBodyLimitTestClient(paddedUpstreamBody(payload, testUpstreamBodyLimit+1), -1, http.StatusOK)
	raw, _, err := c.requestStatus(context.Background(), http.MethodGet, "/v1/stats/users", nil, "")
	if err != nil || len(raw) != testUpstreamBodyLimit+1 {
		t.Fatalf("list alias response bytes = %d, error = %v", len(raw), err)
	}
}
