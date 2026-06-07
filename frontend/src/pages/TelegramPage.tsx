import { useState, useEffect, useRef } from 'react';
import { Bot, Save, Play, Square, AlertCircle, CheckCircle2, Circle } from 'lucide-react';
import { panelApi } from '@/lib/api';
import { useTranslation, Trans } from 'react-i18next';

interface TelegramConfig {
  bot_token: string;
  admin_ids: number[];
  enabled: boolean;
  default_max_tcp_conns: number;
  default_max_unique_ips: number;
}

interface BotStatus {
  running: boolean;
  enabled: boolean;
  pid: number;
  last_error: string;
  configured: boolean;
  script_found: boolean;
}

function StatusBadge({ status }: { status: BotStatus | null }) {
  const { t } = useTranslation();

  if (!status) return null;

  if (!status.script_found) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-500/15 text-yellow-500">
        <AlertCircle className="w-3.5 h-3.5" />
        {t('telegram.botNotFound')}
      </span>
    );
  }

  if (!status.configured) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-surface text-text-secondary border border-border">
        <Circle className="w-3.5 h-3.5" />
        {t('telegram.notConfigured')}
      </span>
    );
  }

  if (status.running) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-500/15 text-green-500">
        <CheckCircle2 className="w-3.5 h-3.5" />
        {status.pid ? t('telegram.runningPid', { pid: status.pid }) : t('telegram.running')}
      </span>
    );
  }

  if (status.enabled && !status.running && status.last_error) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-500/15 text-red-500">
        <AlertCircle className="w-3.5 h-3.5" />
        {t('telegram.errorStatus')}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-surface text-text-secondary border border-border">
      <Circle className="w-3.5 h-3.5" />
      {t('telegram.stopped')}
    </span>
  );
}

export function TelegramPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [botToken, setBotToken] = useState('');
  const [adminIdsText, setAdminIdsText] = useState('');
  const [maxTcpConns, setMaxTcpConns] = useState(50);
  const [maxUniqueIps, setMaxUniqueIps] = useState(5);
  const [status, setStatus] = useState<BotStatus | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadConfig();
    pollStatus();
    pollRef.current = setInterval(pollStatus, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await panelApi.get<TelegramConfig>('/telegram/config');
      setBotToken(data.bot_token || '');
      setAdminIdsText((data.admin_ids || []).join('\n'));
      setMaxTcpConns(data.default_max_tcp_conns || 50);
      setMaxUniqueIps(data.default_max_unique_ips || 5);
    } catch (err: any) {
      setError(err.message || t('telegram.loadError'));
    } finally {
      setLoading(false);
    }
  };

  const pollStatus = async () => {
    try {
      const data = await panelApi.get<BotStatus>('/telegram/status');
      setStatus(data);
    } catch {
      // silent — don't interrupt the user
    }
  };

  const parseAdminIds = (): number[] =>
    adminIdsText
      .split(/[\n,\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => parseInt(s, 10));

  const isConfigured = botToken.trim() !== '' && parseAdminIds().length > 0;

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      setSaveSuccess(false);
      await panelApi.post('/telegram/config', {
        bot_token: botToken.trim(),
        admin_ids: parseAdminIds(),
        default_max_tcp_conns: maxTcpConns,
        default_max_unique_ips: maxUniqueIps,
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
      await pollStatus();
    } catch (err: any) {
      setError(err.message || t('telegram.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    if (!status) return;
    try {
      setToggling(true);
      setError(null);
      if (status.enabled && status.running) {
        await panelApi.post('/telegram/stop');
      } else {
        await panelApi.post('/telegram/start');
      }
      await pollStatus();
    } catch (err: any) {
      setError(err.message || t('telegram.toggleError'));
    } finally {
      setToggling(false);
    }
  };

  const botIsOn = status?.enabled && status?.running;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-text-secondary">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-3">
          <Bot className="w-5 h-5 text-primary" />
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-text-primary">Telegram Bot</h1>
            <StatusBadge status={status} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Start / Stop toggle */}
          <button
            onClick={handleToggle}
            disabled={toggling || !isConfigured || !status?.script_found}
            title={
              !status?.script_found
                ? t('telegram.botNotFoundPath')
                : !isConfigured
                ? t('telegram.requiresToken')
                : botIsOn
                ? t('telegram.stopBot')
                : t('telegram.startBot')
            }
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed
              ${botIsOn
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-green-600 text-white hover:bg-green-700'}`}
          >
            {botIsOn ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {toggling ? '...' : botIsOn ? t('telegram.stop') : t('telegram.start')}
          </button>

          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-2xl space-y-5">

          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500 text-sm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          {saveSuccess && (
            <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-green-500 text-sm flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              {t('telegram.settingsSaved')}
            </div>
          )}

          {/* Error details from process */}
          {status?.last_error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500 text-sm">
              <p className="font-medium mb-1">{t('telegram.botProcessError')}</p>
              <code className="text-xs break-all">{status.last_error}</code>
            </div>
          )}

          {/* Config */}
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 bg-surface">
              <span className="font-semibold text-text-primary">{t('telegram.configSection')}</span>
            </div>
            <div className="p-4 space-y-5 bg-background">

              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-text-primary">Bot Token</label>
                <p className="text-xs text-text-secondary">
                  <Trans
                    i18nKey="telegram.botTokenHint"
                    components={{ mono: <span className="font-mono text-text-primary" /> }}
                  />
                </p>
                <input
                  type="text"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder={t('telegram.botTokenPlaceholder')}
                  className="input w-full font-mono text-sm"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-text-primary">Admin User IDs</label>
                <p className="text-xs text-text-secondary">
                  <Trans
                    i18nKey="telegram.adminIdsHint"
                    components={{ mono: <span className="font-mono text-text-primary" /> }}
                  />
                </p>
                <textarea
                  value={adminIdsText}
                  onChange={(e) => setAdminIdsText(e.target.value)}
                  placeholder={t('telegram.adminIdsPlaceholder')}
                  rows={4}
                  className="input w-full font-mono text-sm resize-none"
                  spellCheck={false}
                />
                {adminIdsText.trim() !== '' && (
                  <p className="text-xs text-text-secondary">
                    {t('telegram.recognizedIds')} {parseAdminIds().join(', ') || '—'}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-text-primary">
                    {t('telegram.maxTcpConnsLabel')}
                  </label>
                  <p className="text-xs text-text-secondary">
                    {t('telegram.maxTcpConnsHint')}
                  </p>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={maxTcpConns}
                    onChange={(e) => setMaxTcpConns(Math.max(1, parseInt(e.target.value) || 50))}
                    className="input w-full"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-text-primary">
                    {t('telegram.maxUniqueIpsLabel')}
                  </label>
                  <p className="text-xs text-text-secondary">
                    {t('telegram.maxUniqueIpsHint')}
                  </p>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={maxUniqueIps}
                    onChange={(e) => setMaxUniqueIps(Math.max(1, parseInt(e.target.value) || 5))}
                    className="input w-full"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Bot status card */}
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 bg-surface">
              <span className="font-semibold text-text-primary">{t('telegram.statusSection')}</span>
            </div>
            <div className="p-4 bg-background space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-text-secondary">{t('telegram.processLabel')}</span>{' '}
                  <span className={status?.running ? 'text-green-500' : 'text-text-secondary'}>
                    {status?.running
                      ? t('telegram.processRunning', { pid: status.pid })
                      : t('telegram.processStopped')}
                  </span>
                </div>
                <div>
                  <span className="text-text-secondary">bot.py:</span>{' '}
                  <span className={status?.script_found ? 'text-green-500' : 'text-yellow-500'}>
                    {status?.script_found ? t('telegram.botPyFound') : t('telegram.botPyNotFound')}
                  </span>
                </div>
              </div>
              {!status?.script_found && (
                <p className="text-xs text-yellow-500">
                  {t('telegram.botPyMissingHint')}
                </p>
              )}
              <p className="text-xs text-text-secondary">
                {t('telegram.autoStartHint')}
              </p>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
