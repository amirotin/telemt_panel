import { useState, useEffect, useRef, useCallback } from 'react';
import { useLogStream } from '@/hooks/useLogStream';
import { Play, Square, Pause, Download, Trash2, Search } from 'lucide-react';

interface LogSourceStatus {
  available: boolean;
  source: string;
  target: string;
  error?: string;
}

const ANSI_RE = /\x1b\[([0-9;]*)m/g;

const ANSI_FG: Record<number, string> = {
  30: '#6b7280', 31: '#f87171', 32: '#4ade80', 33: '#facc15',
  34: '#60a5fa', 35: '#c084fc', 36: '#22d3ee', 37: '#d1d5db',
  90: '#4b5563', 91: '#f87171', 92: '#4ade80', 93: '#fde047',
  94: '#93c5fd', 95: '#d8b4fe', 96: '#67e8f9', 97: '#f9fafb',
};

interface AnsiSpan {
  text: string;
  color?: string;
  dim?: boolean;
  italic?: boolean;
  bold?: boolean;
}

function parseAnsi(raw: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let lastIndex = 0;
  let color: string | undefined;
  let dim = false, italic = false, bold = false;

  const flush = (text: string) => {
    if (text) spans.push({ text, color, dim, italic, bold });
  };

  ANSI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANSI_RE.exec(raw)) !== null) {
    flush(raw.slice(lastIndex, m.index));
    lastIndex = m.index + m[0].length;
    for (const code of m[1].split(';').map(Number)) {
      if (code === 0)  { color = undefined; dim = false; italic = false; bold = false; }
      else if (code === 1) bold   = true;
      else if (code === 2) dim    = true;
      else if (code === 3) italic = true;
      else if (ANSI_FG[code]) color = ANSI_FG[code];
    }
  }
  flush(raw.slice(lastIndex));
  return spans;
}

const OUTER_TS_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/;

function stripOuterTimestamp(raw: string): string {
  return raw.replace(OUTER_TS_RE, '');
}

const TOKEN_RE = new RegExp(
  [
    '(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(?::\\d+)?)',
    '(\\w+=)',
  ].join('|'),
  'g',
);

const TOKEN_COLORS: Record<number, string> = {
  1: '#22d3ee',
  2: '#c084fc',
};

function tokenizeText(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0, key = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    let col = '';
    for (let g = 1; g <= 2; g++) {
      if (m[g] !== undefined) { col = TOKEN_COLORS[g]; break; }
    }
    if (!col) continue;
    if (m.index > last) parts.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    parts.push(<span key={key++} style={{ color: col }}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<span key={key++}>{text.slice(last)}</span>);
  return parts.length ? parts : [<span key={0}>{text}</span>];
}

function renderLogLine(raw: string): React.ReactNode {
  const cleaned = stripOuterTimestamp(raw);
  const spans = parseAnsi(cleaned);

  return (
    <>
      {spans.map((s, i) => {
        const style: React.CSSProperties = {};
        if (s.color)  style.color      = s.color;
        if (s.dim)    style.opacity    = 0.45;
        if (s.italic) style.fontStyle  = 'italic';
        if (s.bold)   style.fontWeight = 600;

        return (
          <span key={i} style={style}>
            {tokenizeText(s.text)}
          </span>
        );
      })}
    </>
  );
}

const LINE_OPTIONS = [100, 200, 500, 1000];

export function LogsPage() {
  const [status, setStatus] = useState<LogSourceStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [initialLines, setInitialLines] = useState(200);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const {
    lines,
    streaming,
    error,
    paused,
    bufferedCount,
    start,
    stop,
    pause,
    resume,
    clear,
  } = useLogStream();

  useEffect(() => {
    const base = (window as any).__BASE_PATH__ || '';
    fetch(`${base}/api/logs/status`, { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((json) => { if (json.ok) setStatus(json.data); })
      .catch(() => {})
      .finally(() => setStatusLoading(false));
  }, []);

  useEffect(() => {
    if (autoScrollRef.current && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [lines]);

  const handleScroll = useCallback(() => {
    const el = logContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    autoScrollRef.current = atBottom;
    setShowScrollButton(!atBottom && streaming);
  }, [streaming]);

  const scrollToBottom = useCallback(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      autoScrollRef.current = true;
      setShowScrollButton(false);
    }
  }, []);

  const handleDownload = useCallback(() => {
    const text = lines.map((l) => l.text).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `telemt-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [lines]);

  const filteredLines = search
    ? lines.filter((l) => l.text.toLowerCase().includes(search.toLowerCase()))
    : lines;

  if (statusLoading) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-text-primary mb-4">Logs</h1>
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }

  if (status && !status.available) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-text-primary mb-4">Logs</h1>
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm text-red-400">
          <div className="font-medium mb-1">Log source unavailable</div>
          <div>{status.error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col h-[calc(100vh-var(--header-height,64px))]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-text-primary">Logs</h1>
          {status && (
            <span className="text-xs px-2 py-1 rounded bg-surface-secondary text-text-secondary">
              {status.source}: {status.target}
            </span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {!streaming ? (
          <button
            onClick={() => start(initialLines)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
          >
            <Play className="w-3.5 h-3.5" />
            Start
          </button>
        ) : (
          <button
            onClick={stop}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700"
          >
            <Square className="w-3.5 h-3.5" />
            Stop
          </button>
        )}

        {streaming && (
          <button
            onClick={paused ? resume : pause}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-surface-secondary text-text-primary rounded hover:bg-surface-secondary/80"
          >
            <Pause className="w-3.5 h-3.5" />
            {paused ? `Resume (${bufferedCount})` : 'Pause'}
          </button>
        )}

        <select
          value={initialLines}
          onChange={(e) => setInitialLines(Number(e.target.value))}
          disabled={streaming}
          className="px-2 py-1.5 text-sm bg-surface-secondary text-text-primary rounded border border-border"
        >
          {LINE_OPTIONS.map((n) => (
            <option key={n} value={n}>{n} lines</option>
          ))}
        </select>

        <div className="relative flex-1 min-w-[200px] max-w-[400px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-secondary" />
          <input
            type="text"
            placeholder="Filter logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-surface-secondary text-text-primary rounded border border-border placeholder:text-text-secondary"
          />
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={handleDownload}
            disabled={lines.length === 0}
            className="p-1.5 text-text-secondary hover:text-text-primary rounded disabled:opacity-30"
            title="Download logs"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={clear}
            disabled={lines.length === 0}
            className="p-1.5 text-text-secondary hover:text-text-primary rounded disabled:opacity-30"
            title="Clear"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-3 bg-red-500/10 border border-red-500/30 rounded px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Log output */}
      <div
        ref={logContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto bg-zinc-950 rounded-lg border border-border font-mono text-xs leading-5 p-3 relative"
      >
        {filteredLines.length === 0 && !streaming ? (
          <div className="text-zinc-500 text-center py-8">
            {lines.length === 0
              ? 'Press Start to begin streaming logs'
              : 'No lines match the filter'}
          </div>
        ) : (
          filteredLines.map((line) => (
            <div key={line.id} className="whitespace-pre-wrap break-all">
              {renderLogLine(line.text)}
            </div>
          ))
        )}
      </div>

      {/* Scroll to bottom indicator */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="fixed bottom-8 right-8 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-full shadow-lg z-50"
        >
          New lines ↓
        </button>
      )}
    </div>
  );
}
