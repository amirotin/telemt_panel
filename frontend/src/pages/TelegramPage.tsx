import { useState, useEffect } from 'react';
import { Bot, Save } from 'lucide-react';
import { panelApi } from '@/lib/api';

interface TelegramConfig {
  bot_token: string;
  admin_ids: number[];
}

export function TelegramPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [botToken, setBotToken] = useState('');
  const [adminIdsText, setAdminIdsText] = useState('');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await panelApi.get<TelegramConfig>('/telegram/config');
      setBotToken(data.bot_token || '');
      setAdminIdsText((data.admin_ids || []).join('\n'));
    } catch (err: any) {
      setError(err.message || 'Failed to load config');
    } finally {
      setLoading(false);
    }
  };

  const parseAdminIds = (): number[] => {
    return adminIdsText
      .split(/[\n,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n) && n > 0);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(false);
      await panelApi.post('/telegram/config', {
        bot_token: botToken.trim(),
        admin_ids: parseAdminIds(),
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to save config');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-3">
          <Bot className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-semibold text-text-primary">Telegram Bot</h1>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-2xl space-y-6">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-600 text-sm">
              {error}
            </div>
          )}
          {success && (
            <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-green-600 text-sm">
              Настройки сохранены успешно.
            </div>
          )}

          <div className="border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 bg-surface">
              <span className="font-semibold text-text-primary">Конфигурация бота</span>
            </div>
            <div className="p-4 space-y-5 bg-background">

              <div className="space-y-1">
                <label className="block text-sm font-medium text-text-primary">
                  Bot Token
                </label>
                <p className="text-xs text-text-secondary">
                  Необходимо получить токен у менеджера ботов Telegram{' '}
                  <span className="font-mono">@botfather</span>
                </p>
                <input
                  type="text"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder="123456789:AABBCCDDEEFFaabbccddeeff-1234567890"
                  className="input w-full font-mono text-sm"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-medium text-text-primary">
                  Admin User IDs
                </label>
                <p className="text-xs text-text-secondary">
                  Один или несколько User ID администратора(-ов) Telegram-бота. Для получения
                  User ID используйте <span className="font-mono">@userinfobot</span> или
                  команду <span className="font-mono">/id</span> в боте. Каждый ID с новой строки.
                </p>
                <textarea
                  value={adminIdsText}
                  onChange={(e) => setAdminIdsText(e.target.value)}
                  placeholder={"541621233\n987654321"}
                  rows={4}
                  className="input w-full font-mono text-sm resize-none"
                  spellCheck={false}
                />
              </div>

            </div>
          </div>

          <div className="border border-border rounded-lg p-4 bg-surface space-y-2">
            <p className="text-sm font-medium text-text-primary">Запуск бота</p>
            <p className="text-xs text-text-secondary">
              Бот запускается отдельным Python-процессом из директории{' '}
              <span className="font-mono">bot/</span>. После сохранения настроек
              перезапустите бот, чтобы применить новый токен и список администраторов.
            </p>
            <pre className="text-xs bg-background rounded p-3 text-text-secondary overflow-x-auto">
{`cd bot
pip install -r requirements.txt
python bot.py`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
