import { Header } from '@/components/layout/Header';
import { StatusBadge } from '@/components/StatusBadge';
import { ErrorAlert } from '@/components/ErrorAlert';
import { useWsSubscription, useEndpoint } from '@/hooks/useWebSocket';

interface SecurityPostureData {
  api_read_only: boolean;
  api_whitelist_enabled: boolean;
  api_whitelist_entries: number;
  api_auth_header_enabled: boolean;
  proxy_protocol_enabled: boolean;
  log_level: string;
  telemetry_core_enabled: boolean;
  telemetry_user_enabled: boolean;
  telemetry_me_level: string;
}

interface WhitelistData {
  enabled: boolean;
  entries_total: number;
  entries: string[];
  generated_at_epoch_secs: number;
}

interface LimitsData {
  [key: string]: unknown;
}

function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

const ENDPOINTS = ['/v1/security/posture', '/v1/security/whitelist', '/v1/limits/effective'];

export function SecurityPage() {
  const { data: wsData, errors, connected, refresh } = useWsSubscription('security', ENDPOINTS, 10);

  const posture = useEndpoint<SecurityPostureData>(wsData, '/v1/security/posture');
  const whitelist = useEndpoint<WhitelistData>(wsData, '/v1/security/whitelist');
  const limits = useEndpoint<LimitsData>(wsData, '/v1/limits/effective');

  const firstError = Object.values(errors)[0];
  const flatLimits = limits ? flattenObject(limits) : {};

  return (
    <div>
      <Header title="Security" refreshing={!connected} onRefresh={refresh} />

      <div className="p-4 lg:p-6 space-y-6">
        {firstError && <ErrorAlert message={firstError} onRetry={refresh} />}

        {posture && (
          <div className="bg-surface border border-border rounded-lg p-4">
            <h3 className="text-sm font-medium text-text-secondary mb-4">Security Posture</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <div className="text-xs text-text-secondary mb-1">API Read-Only</div>
                <StatusBadge status={posture.api_read_only} labelOn="Enabled" labelOff="Disabled" />
              </div>
              <div>
                <div className="text-xs text-text-secondary mb-1">API Whitelist</div>
                <StatusBadge status={posture.api_whitelist_enabled} labelOn={`Enabled (${posture.api_whitelist_entries})`} labelOff="Disabled" />
              </div>
              <div>
                <div className="text-xs text-text-secondary mb-1">API Auth Header</div>
                <StatusBadge status={posture.api_auth_header_enabled} labelOn="Enabled" labelOff="Disabled" />
              </div>
              <div>
                <div className="text-xs text-text-secondary mb-1">Proxy Protocol</div>
                <StatusBadge status={posture.proxy_protocol_enabled} labelOn="Enabled" labelOff="Disabled" />
              </div>
              <div>
                <div className="text-xs text-text-secondary mb-1">Log Level</div>
                <span className="text-sm text-text-primary font-medium">{posture.log_level}</span>
              </div>
              <div>
                <div className="text-xs text-text-secondary mb-1">Telemetry Core</div>
                <StatusBadge status={posture.telemetry_core_enabled} labelOn="Enabled" labelOff="Disabled" />
              </div>
              <div>
                <div className="text-xs text-text-secondary mb-1">Telemetry User</div>
                <StatusBadge status={posture.telemetry_user_enabled} labelOn="Enabled" labelOff="Disabled" />
              </div>
              <div>
                <div className="text-xs text-text-secondary mb-1">Telemetry ME Level</div>
                <span className="text-sm text-text-primary font-medium">{posture.telemetry_me_level}</span>
              </div>
            </div>
          </div>
        )}

        <div>
          <h3 className="text-sm font-medium text-text-secondary mb-3">Whitelist</h3>
          {whitelist && whitelist.entries.length > 0 ? (
            <div className="bg-surface border border-border rounded-lg p-4">
              <div className="flex flex-wrap gap-2">
                {whitelist.entries.map((ip, i) => (
                  <span key={i} className="bg-background px-3 py-1.5 rounded text-sm text-text-primary font-mono border border-border/50">
                    {ip}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="bg-surface border border-border rounded-lg p-6 text-center text-text-secondary text-sm">
              No whitelist entries configured
            </div>
          )}
        </div>

        {limits && (
          <div className="bg-surface border border-border rounded-lg p-4">
            <h3 className="text-sm font-medium text-text-secondary mb-3">Effective Limits</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {Object.entries(flatLimits).map(([key, value]) => (
                <div key={key} className="min-w-0 flex justify-between items-center gap-2 py-1.5 px-2 rounded hover:bg-surface-hover">
                  <span className="text-xs text-text-secondary font-mono truncate">{key}</span>
                  <span className="text-sm text-text-primary font-medium shrink-0">
                    {typeof value === 'boolean' ? (
                      <StatusBadge status={value} />
                    ) : (
                      String(value ?? '-')
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
