import { useState, useEffect, useRef } from 'react';
import { Header } from '@/components/layout/Header';
import { MetricCard } from '@/components/MetricCard';
import { ErrorAlert } from '@/components/ErrorAlert';
import { panelApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { RefreshCw, Download, CheckCircle2, XCircle, Loader2, ArrowRight } from 'lucide-react';

interface UpdateStatus {
  phase: string;
  message?: string;
  error?: string;
  log?: string[];
}

interface ReleaseInfo {
  version: string;
  name: string;
  changelog: string;
  published_at: string;
  html_url: string;
  prerelease: boolean;
  is_downgrade: boolean;
  asset_url: string;
  asset_size: number;
  checksum_url: string;
}

interface ReleasesResult {
  current_version: string;
  releases: ReleaseInfo[];
}

const PHASE_STEPS = ['checking', 'downloading', 'verifying', 'replacing', 'restarting'];
interface AutoUpdateConfig {
  enabled: boolean;
  check_interval: string;
  auto_apply: boolean;
}

interface AutoUpdateComponentState {
  config: AutoUpdateConfig;
  last_check: { current_version: string; latest_version: string; update_available: boolean; release_name: string } | null;
  last_check_at: string | null;
}

interface AutoUpdateStatus {
  panel: AutoUpdateComponentState;
  telemt: AutoUpdateComponentState;
}

const INTERVAL_OPTIONS = [
  { value: '5m', label: '5 минут' },
  { value: '15m', label: '15 минут' },
  { value: '30m', label: '30 минут' },
  { value: '1h', label: '1 час' },
  { value: '3h', label: '3 часа' },
  { value: '6h', label: '6 часов' },
  { value: '12h', label: '12 часов' },
  { value: '24h', label: '24 часа' },
];

function AutoUpdateCard({
  title,
  state,
  onSave,
}: {
  title: string;
  state: AutoUpdateComponentState;
  onSave: (config: AutoUpdateConfig) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(state.config.enabled);
  const [interval, setInterval] = useState(state.config.check_interval || '1h');
  const [autoApply, setAutoApply] = useState(state.config.auto_apply);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEnabled(state.config.enabled);
    setInterval(state.config.check_interval || '1h');
    setAutoApply(state.config.auto_apply);
  }, [state.config.enabled, state.config.check_interval, state.config.auto_apply]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ enabled, check_interval: interval, auto_apply: autoApply });
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = enabled !== state.config.enabled || interval !== (state.config.check_interval || '1h') || autoApply !== state.config.auto_apply;

  return (
    <div className="bg-surface rounded-lg p-4 lg:p-5 border border-border">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs lg:text-sm font-semibold text-text-primary">{title}</h3>
        {state.last_check_at && (
          <span className="text-[10px] lg:text-xs text-text-secondary">
            Последняя проверка: {new Date(state.last_check_at).toLocaleString('ru-RU')}
          </span>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-secondary">{enabled ? "Вкл" : "Выкл"}</span>
          <button
            onClick={() => setEnabled(!enabled)}
            className={cn(
              'relative w-10 h-5 rounded-full transition-colors',
              enabled ? 'bg-accent' : 'bg-border'
            )}
          >
            <span className={cn(
              'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
              enabled ? 'left-5' : 'left-0.5'
            )} />
          </button>
        </div>

        {enabled && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-secondary">Интервал проверки</span>
              <select
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                className="bg-background text-text-primary rounded px-2 py-1 text-sm border border-border focus:border-accent focus:outline-none"
              >
                {INTERVAL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-text-secondary">Автоустановка</span>
              <button
                onClick={() => setAutoApply(!autoApply)}
                className={cn(
                  'relative w-10 h-5 rounded-full transition-colors',
                  autoApply ? 'bg-accent' : 'bg-border'
                )}
              >
                <span className={cn(
                  'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                  autoApply ? 'left-5' : 'left-0.5'
                )} />
              </button>
            </div>
          </>
        )}

        {state.last_check && (
          <div className="flex items-center gap-2 text-xs">
            {state.last_check.update_available ? (
              <span className="text-accent">
                Доступно: {state.last_check.latest_version}
              </span>
            ) : (
              <span className="text-success">
                Актуально ({state.last_check.current_version})
              </span>
            )}
          </div>
        )}

        {hasChanges && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        )}
      </div>
    </div>
  );
}


function VersionSelect({
  releases,
  selected,
  onSelect,
  loading,
  error,
  onRetry,
  currentVersion,
}: {
  releases: ReleaseInfo[];
  selected: ReleaseInfo | null;
  onSelect: (r: ReleaseInfo) => void;
  loading: boolean;
  error: string;
  onRetry: () => void;
  currentVersion: string;
}) {
  if (loading) {
    return <div className="text-sm text-text-secondary">Загрузка релизов...</div>;
  }
  if (error) {
    return (
      <div className="text-sm text-red-400">
        {error}{' '}
        <button onClick={onRetry} className="underline hover:text-red-300">
          Повторить
        </button>
      </div>
    );
  }
  if (releases.length === 0) {
    return <div className="text-sm text-text-secondary">Нет доступных версий</div>;
  }
  return (
    <select
      className="w-full bg-surface text-text-primary rounded px-3 py-1.5 text-sm border border-border focus:border-accent focus:outline-none"
      value={selected?.version || ''}
      onChange={(e) => {
        const r = releases.find((r) => r.version === e.target.value);
        if (r) onSelect(r);
      }}
    >
      <option value="" disabled>
        Выберите версию
      </option>
      {currentVersion && (
        <option value="__current__" disabled>
          {currentVersion} (текущая)
        </option>
      )}
      {releases.map((r) => (
        <option key={r.version} value={r.version}>
          {r.version}
          {r.prerelease ? ' ⚠ pre-release' : ''}
          {r.is_downgrade ? ' ↓ downgrade' : ''}
        </option>
      ))}
    </select>
  );
}

function ConfirmModal({
  release,
  onConfirm,
  onCancel,
}: {
  release: ReleaseInfo;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const warnings: string[] = [];
  if (release.prerelease) {
    warnings.push(`Это pre-release версия ${release.version}. Она может быть нестабильной.`);
  }
  if (release.is_downgrade) {
    warnings.push(`Вы собираетесь откатиться на более старую версию ${release.version}.`);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface rounded-lg p-6 max-w-md mx-4 border border-border">
        <h3 className="text-lg font-semibold text-text-primary mb-4">Подтверждение</h3>
        {warnings.map((w, i) => (
          <p key={i} className="text-warning text-sm mb-2">{w}</p>
        ))}
        <p className="text-text-secondary text-sm mt-4">Продолжить установку?</p>
        <div className="flex gap-3 mt-6 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded bg-surface-hover text-text-primary hover:bg-border text-sm"
          >
            Отмена
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded bg-warning text-white hover:opacity-90 text-sm"
          >
            Продолжить
          </button>
        </div>
      </div>
    </div>
  );
}

export function UpdatePage() {
  // Telemt update state
  const [currentVersion, setCurrentVersion] = useState('');
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Panel update state
  const [panelCurrentVersion, setPanelCurrentVersion] = useState('');
  const [panelStatus, setPanelStatus] = useState<UpdateStatus | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const panelPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Telemt releases
  const [releases, setReleases] = useState<ReleaseInfo[]>([]);
  const [selectedRelease, setSelectedRelease] = useState<ReleaseInfo | null>(null);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [releasesError, setReleasesError] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

  // Panel releases
  const [panelReleases, setPanelReleases] = useState<ReleaseInfo[]>([]);
  const [panelSelectedRelease, setPanelSelectedRelease] = useState<ReleaseInfo | null>(null);
  const [panelReleasesLoading, setPanelReleasesLoading] = useState(false);
  const [panelReleasesError, setPanelReleasesError] = useState('');
  const [panelShowConfirm, setPanelShowConfirm] = useState(false);

  // Auto-update state
  const [autoStatus, setAutoStatus] = useState<AutoUpdateStatus | null>(null);

  // Fetch auto-update status
  const fetchAutoStatus = async () => {
    try {
      const res = await panelApi.get<AutoUpdateStatus>('/auto-update/status');
      setAutoStatus(res);
    } catch {
      // Ignore - feature may not be available
    }
  };

  const handleAutoUpdateConfig = async (component: 'panel' | 'telemt', cfg: AutoUpdateConfig) => {
    try {
      const fallback: AutoUpdateConfig = { enabled: false, check_interval: '1h', auto_apply: false };
      const payload = {
        panel: component === 'panel' ? cfg : (autoStatus?.panel?.config || fallback),
        telemt: component === 'telemt' ? cfg : (autoStatus?.telemt?.config || fallback),
      };
      const res = await panelApi.put<AutoUpdateStatus>('/auto-update/config', payload);
      setAutoStatus(res);
    } catch (e: any) {
      alert('Ошибка: ' + (e.message || 'Не удалось сохранить настройки'));
    }
  };

  const isUpdating = status && !['idle', 'done', 'error'].includes(status.phase);
  const isPanelUpdating = panelStatus && !['idle', 'done', 'error'].includes(panelStatus.phase);

  // Fetch releases functions
  const fetchReleases = async () => {
    setReleasesLoading(true);
    setReleasesError('');
    try {
      const res = await panelApi.get<ReleasesResult>('/update/releases');
      setCurrentVersion(res.current_version || '');
      setReleases(res.releases || []);
      const defaultRelease = (res.releases || []).find(r => !r.prerelease && !r.is_downgrade);
      setSelectedRelease(defaultRelease || null);
    } catch (e: any) {
      setReleasesError(e.message || 'Ошибка загрузки релизов');
    } finally {
      setReleasesLoading(false);
    }
  };

  const fetchPanelReleases = async () => {
    setPanelReleasesLoading(true);
    setPanelReleasesError('');
    try {
      const res = await panelApi.get<ReleasesResult>('/panel/update/releases');
      setPanelCurrentVersion(res.current_version || '');
      setPanelReleases(res.releases || []);
      const defaultRelease = (res.releases || []).find(r => !r.prerelease && !r.is_downgrade);
      setPanelSelectedRelease(defaultRelease || null);
    } catch (e: any) {
      setPanelReleasesError(e.message || 'Ошибка загрузки релизов');
    } finally {
      setPanelReleasesLoading(false);
    }
  };

  // Telemt update functions
  const handleApply = async () => {
    if (!selectedRelease) return;
    if (selectedRelease.prerelease || selectedRelease.is_downgrade) {
      setShowConfirm(true);
      return;
    }
    doApply();
  };

  const doApply = async () => {
    setShowConfirm(false);
    try {
      await panelApi.post('/update/apply', { version: selectedRelease?.version });
      startPolling();
    } catch (e: any) {
      setError(e.message);
    }
  };

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const s = await panelApi.get<UpdateStatus>('/update/status');
        setStatus(s);
        if (s.phase === 'done' || s.phase === 'error') {
          stopPolling();
          if (s.phase === 'done') {
            fetchReleases();
          }
        }
      } catch {
        // Panel might be restarting, keep polling
      }
    }, 1000);
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // Panel update functions
  const handlePanelApply = async () => {
    if (!panelSelectedRelease) return;
    if (panelSelectedRelease.prerelease || panelSelectedRelease.is_downgrade) {
      setPanelShowConfirm(true);
      return;
    }
    doPanelApply();
  };

  const doPanelApply = async () => {
    setPanelShowConfirm(false);
    try {
      await panelApi.post('/panel/update/apply', { version: panelSelectedRelease?.version });
      startPanelPolling();
    } catch (e: any) {
      setPanelError(e.message);
    }
  };

  function startPanelPolling() {
    stopPanelPolling();
    panelPollRef.current = setInterval(async () => {
      try {
        const s = await panelApi.get<UpdateStatus>('/panel/update/status');
        setPanelStatus(s);
        if (s.phase === 'done' || s.phase === 'error') {
          stopPanelPolling();
          if (s.phase === 'done') {
            fetchPanelReleases();
          }
        }
      } catch {
        // Panel might be restarting, keep polling
      }
    }, 1000);
  }

  function stopPanelPolling() {
    if (panelPollRef.current) {
      clearInterval(panelPollRef.current);
      panelPollRef.current = null;
    }
  }

  useEffect(() => {
    fetchReleases();
    fetchPanelReleases();
    fetchAutoStatus();
    return () => {
      stopPolling();
      stopPanelPolling();
    };
  }, []);

  const currentStep = status ? PHASE_STEPS.indexOf(status.phase) : -1;
  const panelCurrentStep = panelStatus ? PHASE_STEPS.indexOf(panelStatus.phase) : -1;

  return (
    <div className="min-h-screen">
      <Header title="Update" onRefresh={() => { fetchReleases(); fetchPanelReleases(); }} />
      <div className="p-4 lg:p-6 space-y-4 lg:space-y-6 max-w-3xl">

        {/* Auto-update settings */}
        {autoStatus && (
          <div className="bg-surface rounded-lg p-4 lg:p-5 border border-border">
            <h2 className="text-xs lg:text-sm font-semibold text-text-primary mb-3 lg:mb-4">Автообновление</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 lg:gap-4">
              <AutoUpdateCard
                title="Panel"
                state={autoStatus.panel}
                onSave={(cfg) => handleAutoUpdateConfig('panel', cfg)}
              />
              <AutoUpdateCard
                title="Telemt"
                state={autoStatus.telemt}
                onSave={(cfg) => handleAutoUpdateConfig('telemt', cfg)}
              />
            </div>
          </div>
        )}

        {/* Panel Update Section */}
        <div className="bg-surface rounded-lg p-4 lg:p-5 border border-border">
          <div className="flex items-center justify-between mb-3 lg:mb-4">
            <h2 className="text-xs lg:text-sm font-semibold text-text-primary">Panel Version</h2>
            <button
              onClick={fetchPanelReleases}
              disabled={panelReleasesLoading || !!isPanelUpdating}
              className={cn(
                'flex items-center gap-1.5 lg:gap-2 px-2.5 lg:px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                'bg-accent/15 text-accent hover:bg-accent/25',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              <RefreshCw size={12} className={cn('lg:w-3.5 lg:h-3.5', panelReleasesLoading && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh releases</span>
              <span className="sm:hidden">Refresh</span>
            </button>
          </div>

          {panelError && <ErrorAlert message={panelError} />}

          <div className="space-y-3 lg:space-y-4">
            <div className="grid grid-cols-2 gap-2 lg:gap-3">
              <MetricCard label="Current Version" value={panelCurrentVersion || '—'} />
              <div className="flex items-center">
                <VersionSelect
                  releases={panelReleases}
                  selected={panelSelectedRelease}
                  onSelect={setPanelSelectedRelease}
                  loading={panelReleasesLoading}
                  error={panelReleasesError}
                  onRetry={fetchPanelReleases}
                  currentVersion={panelCurrentVersion}
                />
              </div>
            </div>

            {panelSelectedRelease && (
              <div className="bg-accent/10 border border-accent/30 rounded-md p-3 lg:p-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs lg:text-sm font-medium text-accent">
                      {panelSelectedRelease.name}
                    </p>
                    <p className="text-xs text-text-secondary mt-1">
                      Published {new Date(panelSelectedRelease.published_at).toLocaleDateString()}
                      {' · '}
                      <a
                        href={panelSelectedRelease.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                      >
                        Release notes
                      </a>
                    </p>
                  </div>
                  <button
                    onClick={handlePanelApply}
                    disabled={!panelSelectedRelease || !!isPanelUpdating}
                    className={cn(
                      'flex items-center justify-center gap-2 px-3 lg:px-4 py-2 rounded-md text-xs lg:text-sm font-medium transition-colors w-full sm:w-auto',
                      'bg-accent text-white hover:bg-accent/90',
                      'disabled:opacity-50 disabled:cursor-not-allowed'
                    )}
                  >
                    <Download size={14} className="lg:w-4 lg:h-4" />
                    Update
                  </button>
                </div>

                {panelSelectedRelease.changelog && (
                  <details className="mt-3">
                    <summary className="text-xs text-text-secondary cursor-pointer hover:text-text-primary">
                      Changelog
                    </summary>
                    <pre className="mt-2 text-xs text-text-secondary whitespace-pre-wrap bg-background rounded p-2 lg:p-3 max-h-48 overflow-y-auto">
                      {panelSelectedRelease.changelog}
                    </pre>
                  </details>
                )}
              </div>
            )}

            {!panelSelectedRelease && !panelReleasesLoading && panelReleases.length === 0 && !panelReleasesError && (
              <div className="flex items-center gap-2 text-xs lg:text-sm text-success">
                <CheckCircle2 size={14} className="lg:w-4 lg:h-4" />
                You are running the latest version
              </div>
            )}
          </div>
        </div>

        {/* Panel Update Progress */}
        {panelStatus && panelStatus.phase !== 'idle' && (
          <div className="bg-surface rounded-lg p-4 lg:p-5 border border-border">
            <h2 className="text-xs lg:text-sm font-semibold text-text-primary mb-3 lg:mb-4">Panel Update Progress</h2>

            {/* Step indicators */}
            <div className="flex items-center gap-0.5 lg:gap-1 mb-3 lg:mb-4 overflow-x-auto">
              {PHASE_STEPS.map((step, i) => {
                const isActive = step === panelStatus.phase;
                const isCompleted = panelCurrentStep > i;
                const isFailed = panelStatus.phase === 'error' && panelCurrentStep === i;

                return (
                  <div key={step} className="flex items-center gap-0.5 lg:gap-1 flex-1 min-w-0">
                    <div className="flex flex-col items-center flex-1 min-w-0">
                      <div
                        className={cn(
                          'w-7 h-7 lg:w-8 lg:h-8 rounded-full flex items-center justify-center text-xs border-2 transition-colors shrink-0',
                          isCompleted && 'bg-success/15 border-success text-success',
                          isActive && !isFailed && 'bg-accent/15 border-accent text-accent',
                          isFailed && 'bg-danger/15 border-danger text-danger',
                          !isCompleted && !isActive && !isFailed && 'border-border text-text-secondary'
                        )}
                      >
                        {isCompleted ? (
                          <CheckCircle2 size={14} className="lg:w-4 lg:h-4" />
                        ) : isActive && !isFailed ? (
                          <Loader2 size={14} className="lg:w-4 lg:h-4 animate-spin" />
                        ) : isFailed ? (
                          <XCircle size={14} className="lg:w-4 lg:h-4" />
                        ) : (
                          i + 1
                        )}
                      </div>
                      <span className="text-[9px] lg:text-[10px] text-text-secondary mt-1 capitalize truncate max-w-full text-center px-1">{step}</span>
                    </div>
                    {i < PHASE_STEPS.length - 1 && (
                      <ArrowRight size={10} className="lg:w-3 lg:h-3 text-border mb-4 shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Status message */}
            {panelStatus.message && (
              <p className="text-xs text-text-secondary bg-background rounded p-2">
                {panelStatus.message}
              </p>
            )}

            {/* Error */}
            {panelStatus.phase === 'error' && panelStatus.error && (
              <div className="mt-2">
                <ErrorAlert message={panelStatus.error} />
              </div>
            )}

            {/* Done */}
            {panelStatus.phase === 'done' && (
              <div className="flex items-center gap-2 text-xs lg:text-sm text-success mt-2">
                <CheckCircle2 size={14} className="lg:w-4 lg:h-4" />
                {panelStatus.message}
              </div>
            )}

            {/* Debug Log */}
            {panelStatus.log && panelStatus.log.length > 0 && (
              <details className="mt-3" open={panelStatus.phase === 'error'}>
                <summary className="text-xs text-text-secondary cursor-pointer hover:text-text-primary">
                  Log ({panelStatus.log.length} entries)
                </summary>
                <div className="mt-2 max-h-48 overflow-y-auto bg-background rounded p-2 font-mono text-[10px] lg:text-[11px] text-text-secondary space-y-0.5">
                  {panelStatus.log.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {/* Telemt Update Section */}
        {error && <ErrorAlert message={error} />}

        <div className="bg-surface rounded-lg p-4 lg:p-5 border border-border">
          <div className="flex items-center justify-between mb-3 lg:mb-4">
            <h2 className="text-xs lg:text-sm font-semibold text-text-primary">Telemt Version</h2>
            <button
              onClick={fetchReleases}
              disabled={releasesLoading || !!isUpdating}
              className={cn(
                'flex items-center gap-1.5 lg:gap-2 px-2.5 lg:px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                'bg-accent/15 text-accent hover:bg-accent/25',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              <RefreshCw size={12} className={cn('lg:w-3.5 lg:h-3.5', releasesLoading && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh releases</span>
              <span className="sm:hidden">Refresh</span>
            </button>
          </div>

          <div className="space-y-3 lg:space-y-4">
            <div className="grid grid-cols-2 gap-2 lg:gap-3">
              <MetricCard label="Current Version" value={currentVersion || '—'} />
              <div className="flex items-center">
                <VersionSelect
                  releases={releases}
                  selected={selectedRelease}
                  onSelect={setSelectedRelease}
                  loading={releasesLoading}
                  error={releasesError}
                  onRetry={fetchReleases}
                  currentVersion={currentVersion}
                />
              </div>
            </div>

            {selectedRelease && (
              <div className="bg-accent/10 border border-accent/30 rounded-md p-3 lg:p-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs lg:text-sm font-medium text-accent">
                      {selectedRelease.name}
                    </p>
                    <p className="text-xs text-text-secondary mt-1">
                      Published {new Date(selectedRelease.published_at).toLocaleDateString()}
                      {' · '}
                      <a
                        href={selectedRelease.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                      >
                        Release notes
                      </a>
                    </p>
                  </div>
                  <button
                    onClick={handleApply}
                    disabled={!selectedRelease || !!isUpdating}
                    className={cn(
                      'flex items-center justify-center gap-2 px-3 lg:px-4 py-2 rounded-md text-xs lg:text-sm font-medium transition-colors w-full sm:w-auto',
                      'bg-accent text-white hover:bg-accent/90',
                      'disabled:opacity-50 disabled:cursor-not-allowed'
                    )}
                  >
                    <Download size={14} className="lg:w-4 lg:h-4" />
                    Update
                  </button>
                </div>

                {selectedRelease.changelog && (
                  <details className="mt-3">
                    <summary className="text-xs text-text-secondary cursor-pointer hover:text-text-primary">
                      Changelog
                    </summary>
                    <pre className="mt-2 text-xs text-text-secondary whitespace-pre-wrap bg-background rounded p-2 lg:p-3 max-h-48 overflow-y-auto">
                      {selectedRelease.changelog}
                    </pre>
                  </details>
                )}
              </div>
            )}

            {!selectedRelease && !releasesLoading && releases.length === 0 && !releasesError && (
              <div className="flex items-center gap-2 text-xs lg:text-sm text-success">
                <CheckCircle2 size={14} className="lg:w-4 lg:h-4" />
                You are running the latest version
              </div>
            )}
          </div>
        </div>

        {/* Update Progress */}
        {status && status.phase !== 'idle' && (
          <div className="bg-surface rounded-lg p-4 lg:p-5 border border-border">
            <h2 className="text-xs lg:text-sm font-semibold text-text-primary mb-3 lg:mb-4">Telemt Update Progress</h2>

            {/* Step indicators */}
            <div className="flex items-center gap-0.5 lg:gap-1 mb-3 lg:mb-4 overflow-x-auto">
              {PHASE_STEPS.map((step, i) => {
                const isActive = step === status.phase;
                const isCompleted = currentStep > i;
                const isFailed = status.phase === 'error' && currentStep === i;

                return (
                  <div key={step} className="flex items-center gap-0.5 lg:gap-1 flex-1 min-w-0">
                    <div className="flex flex-col items-center flex-1 min-w-0">
                      <div
                        className={cn(
                          'w-7 h-7 lg:w-8 lg:h-8 rounded-full flex items-center justify-center text-xs border-2 transition-colors shrink-0',
                          isCompleted && 'bg-success/15 border-success text-success',
                          isActive && !isFailed && 'bg-accent/15 border-accent text-accent',
                          isFailed && 'bg-danger/15 border-danger text-danger',
                          !isCompleted && !isActive && !isFailed && 'border-border text-text-secondary'
                        )}
                      >
                        {isCompleted ? (
                          <CheckCircle2 size={14} className="lg:w-4 lg:h-4" />
                        ) : isActive && !isFailed ? (
                          <Loader2 size={14} className="lg:w-4 lg:h-4 animate-spin" />
                        ) : isFailed ? (
                          <XCircle size={14} className="lg:w-4 lg:h-4" />
                        ) : (
                          i + 1
                        )}
                      </div>
                      <span className="text-[9px] lg:text-[10px] text-text-secondary mt-1 capitalize truncate max-w-full text-center px-1">{step}</span>
                    </div>
                    {i < PHASE_STEPS.length - 1 && (
                      <ArrowRight size={10} className="lg:w-3 lg:h-3 text-border mb-4 shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Status message */}
            {status.message && (
              <p className="text-xs text-text-secondary bg-background rounded p-2">
                {status.message}
              </p>
            )}

            {/* Error */}
            {status.phase === 'error' && status.error && (
              <div className="mt-2">
                <ErrorAlert message={status.error} />
              </div>
            )}

            {/* Done */}
            {status.phase === 'done' && (
              <div className="flex items-center gap-2 text-xs lg:text-sm text-success mt-2">
                <CheckCircle2 size={14} className="lg:w-4 lg:h-4" />
                {status.message}
              </div>
            )}

            {/* Debug Log */}
            {status.log && status.log.length > 0 && (
              <details className="mt-3" open={status.phase === 'error'}>
                <summary className="text-xs text-text-secondary cursor-pointer hover:text-text-primary">
                  Log ({status.log.length} entries)
                </summary>
                <div className="mt-2 max-h-48 overflow-y-auto bg-background rounded p-2 font-mono text-[10px] lg:text-[11px] text-text-secondary space-y-0.5">
                  {status.log.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {/* Confirm Modals */}
        {showConfirm && selectedRelease && (
          <ConfirmModal
            release={selectedRelease}
            onConfirm={doApply}
            onCancel={() => setShowConfirm(false)}
          />
        )}
        {panelShowConfirm && panelSelectedRelease && (
          <ConfirmModal
            release={panelSelectedRelease}
            onConfirm={doPanelApply}
            onCancel={() => setPanelShowConfirm(false)}
          />
        )}
      </div>
    </div>
  );
}
