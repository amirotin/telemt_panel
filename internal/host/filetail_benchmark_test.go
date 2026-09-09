package host

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"testing"
	"time"
)

func BenchmarkReadNewLinesBounded(b *testing.B) {
	for _, size := range []int{1 << 20, 16 << 20} {
		for _, shape := range []string{"short-lines", "huge-line", "growing-partial"} {
			b.Run(fmt.Sprintf("%s/%dMiB", shape, size>>20), func(b *testing.B) {
				data := bytes.Repeat([]byte{'x'}, size)
				if shape == "short-lines" {
					for i := 127; i < len(data); i += 128 {
						data[i] = '\n'
					}
				} else if shape == "huge-line" {
					data[len(data)-1] = '\n'
				}
				reader := bytes.NewReader(data)
				b.SetBytes(int64(len(data)))
				b.ReportAllocs()
				b.ResetTimer()
				retained := 0
				for i := 0; i < b.N; i++ {
					var cursor fileFollowCursor
					scratch := make([]byte, followChunkBytes)
					step := len(data)
					if shape == "growing-partial" {
						step = followChunkBytes
					}
					for end := step; end <= len(data); end += step {
						if err := readNewLines(context.Background(), reader, int64(end), &cursor, scratch, func(string) bool { return true }); err != nil {
							b.Fatal(err)
						}
					}
					retained = max(retained, cap(cursor.partial))
				}
				b.ReportMetric(float64(retained), "retained-prefix-B")
			})
		}
	}
}

// Run alone with RUN_LOG_FOLLOW_HEAP=1 to measure the reader at a blocked
// subscriber boundary. Synthetic ReaderAt input does not occupy the Go heap.
// This measures retained Go heap, not process RSS or the full HTTP/SSE pipeline.
func TestFileFollowBlockedHeap(t *testing.T) {
	if os.Getenv("RUN_LOG_FOLLOW_HEAP") != "1" {
		t.Skip("opt-in isolated heap measurement")
	}
	for _, shape := range []string{"short-lines", "huge-line"} {
		for _, size := range []int64{1 << 20, 16 << 20, 128 << 20} {
			t.Run(fmt.Sprintf("%s/%d", shape, size), func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				entered := make(chan struct{})
				done := make(chan error, 1)
				var cursor fileFollowCursor
				reads := 0
				reader := followReaderAtFunc(func(p []byte, offset int64) (int, error) {
					reads++
					for i := range p {
						p[i] = 'x'
						if shape == "short-lines" && (offset+int64(i))%128 == 127 || offset+int64(i) == size-1 {
							p[i] = '\n'
						}
					}
					return len(p), nil
				})
				runtime.GC()
				var before, blocked runtime.MemStats
				runtime.ReadMemStats(&before)
				go func() {
					done <- readNewLines(ctx, reader, size, &cursor, make([]byte, followChunkBytes), func(line string) bool {
						close(entered)
						<-ctx.Done()
						runtime.KeepAlive(line)
						return false
					})
				}()
				select {
				case <-entered:
				case err := <-done:
					t.Fatalf("reader stopped before subscriber blocked: %v", err)
				case <-time.After(5 * time.Second):
					t.Fatal("reader did not reach subscriber")
				}
				runtime.GC()
				runtime.ReadMemStats(&blocked)
				t.Logf("shape=%s backlog=%d heap_delta=%d prefix_capacity=%d reads_before_block=%d", shape, size, int64(blocked.HeapAlloc)-int64(before.HeapAlloc), cap(cursor.partial), reads)
				wantReads := int64(1)
				if shape == "huge-line" {
					wantReads = size / followChunkBytes
				}
				if int64(reads) != wantReads || cap(cursor.partial) > maxFollowLineBytes {
					t.Fatal("reader exceeded first-line reads or prefix cap")
				}
				cancel()
				select {
				case err := <-done:
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("cancelled read: %v", err)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("blocked subscriber did not cancel")
				}
				runtime.KeepAlive(cursor)
			})
		}
	}
}
