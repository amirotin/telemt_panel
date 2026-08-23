import { useState, useEffect } from 'react';
import { Settings, Save, RotateCw, X } from 'lucide-react';
import { panelApi } from '@/lib/api';
import { QuickSettingsTab } from '@/components/config/QuickSettingsTab';
import { AdvancedEditorTab } from '@/components/config/AdvancedEditorTab';

type Tab = 'quick' | 'advanced';

interface ConfigData {
  content: string;
  path: string;
  hash: string;
  mode: 'api' | 'file';
}

export function ConfigPage() {
  const [activeTab, setActiveTab] = useState<Tab>('quick');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [originalContent, setOriginalContent] = useState('');
  const [currentContent, setCurrentContent] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [mode, setMode] = useState<'api' | 'file'>('api');
  const [configHash, setConfigHash] = useState('');

  useEffect(() => {
    loadConfig();
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasChanges]);

  const loadConfig = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await panelApi.get<ConfigData>('/telemt/config/raw');
      setOriginalContent(data.content);
      setCurrentContent(data.content);
      setConfigPath(data.path);
      setMode(data.mode ?? 'file');
      // In file mode Quick Settings would rewrite the whole file via a TOML
      // round-trip, destroying the operator's comments — see the tab guard.
      if ((data.mode ?? 'file') === 'file') setActiveTab('advanced');
      setConfigHash(data.hash ?? '');
      setHasChanges(false);
    } catch (err: any) {
      setError(err.message || 'Failed to load config');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (restart: boolean) => {
    if (!hasChanges) return;

    try {
      setSaving(true);
      setError(null);

      const result = await panelApi.post<{ new_hash?: string; restart_required?: boolean }>(
        '/telemt/config/save',
        { content: currentContent, hash: configHash, restart },
      );

      setOriginalContent(currentContent);
      setHasChanges(false);
      if (result?.new_hash) setConfigHash(result.new_hash);

      const restarted = restart || result?.restart_required;
      alert(restarted ? 'Config saved and Telemt restarting...' : 'Config saved successfully');
    } catch (err: any) {
      if (err?.code === 'revision_conflict') {
        setError('Config changed on the server. Reloading…');
        await loadConfig();
        alert('The Telemt config changed since you opened it. Your edits were not saved — the latest version was reloaded.');
        return;
      }
      setError(err.message || 'Failed to save config');
      alert('Error: ' + (err.message || 'Failed to save config'));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!hasChanges) return;
    if (confirm('Discard all changes?')) {
      setCurrentContent(originalContent);
      setHasChanges(false);
    }
  };

  const handleContentChange = (newContent: string) => {
    setCurrentContent(newContent);
    setHasChanges(newContent !== originalContent);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-text-secondary">Loading configuration...</div>
      </div>
    );
  }

  if (error && !currentContent) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-red-500">{error}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {mode === 'api' && (
        <div className="px-4 py-2 bg-blue-500/10 border-b border-blue-500/20 text-sm text-blue-600">
          API mode — main sections only. For full-file access set <code>config_edit_mode = "file"</code>.
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-3">
          <Settings className="w-5 h-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Telemt Configuration</h1>
            <p className="text-sm text-text-secondary">{configPath}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {hasChanges && (
            <button
              onClick={handleDiscard}
              disabled={saving}
              className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-surface-hover transition-colors flex items-center gap-2"
            >
              <X className="w-4 h-4" />
              Discard
            </button>
          )}

          <button
            onClick={() => handleSave(false)}
            disabled={!hasChanges || saving}
            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save'}
          </button>

          <button
            onClick={() => handleSave(true)}
            disabled={!hasChanges || saving}
            className="px-3 py-1.5 text-sm rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            <RotateCw className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save & Restart'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('quick')}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'quick'
              ? 'text-primary border-b-2 border-primary'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          Quick Settings
        </button>
        <button
          onClick={() => setActiveTab('advanced')}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'advanced'
              ? 'text-primary border-b-2 border-primary'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          Advanced Editor
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'quick' ? (
          mode === 'file' ? (
            <div className="p-6 max-w-2xl">
              <p className="text-sm text-text-primary mb-2">
                Quick Settings are disabled in file edit mode.
              </p>
              <p className="text-sm text-text-secondary mb-4">
                The form regenerates the whole TOML file and would strip your
                comments and formatting. Use the Advanced Editor to edit the
                file directly, or switch <code>config_edit_mode</code> to{' '}
                <code>"api"</code> to edit settings safely through the Telemt API.
              </p>
              <button
                onClick={() => setActiveTab('advanced')}
                className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-surface-hover transition-colors"
              >
                Open Advanced Editor
              </button>
            </div>
          ) : (
            <QuickSettingsTab
              content={currentContent}
              onChange={handleContentChange}
              mode={mode}
            />
          )
        ) : (
          <AdvancedEditorTab
            content={currentContent}
            onChange={handleContentChange}
          />
        )}
      </div>

      {hasChanges && (
        <div className="px-4 py-2 bg-yellow-500/10 border-t border-yellow-500/20 text-sm text-yellow-600">
          You have unsaved changes
        </div>
      )}
    </div>
  );
}
