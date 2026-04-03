import { Header } from '@/components/layout/Header';
import { MetricCard } from '@/components/MetricCard';
import { StatusDot } from '@/components/StatusDot';
import { StatusBadge } from '@/components/StatusBadge';
import { ErrorAlert } from '@/components/ErrorAlert';
import { CollapsibleSection } from '@/components/CollapsibleSection';
import { StartupStatus } from '@/components/StartupStatus';
import { useWsSubscription, useEndpoint } from '@/hooks/useWebSocket';
import { usePolling } from '@/hooks/usePolling';
import { telemt } from '@/lib/api';
import { formatUptime, formatNumber, formatBytes } from '@/lib/utils';
import { Activity, Clock, Users, ArrowUpDown, Globe } from 'lucide-react';
import { useMemo } from 'react';

interface HealthData {
  status: string;
  read_only: boolean;
}

interface SummaryData {
  uptime_seconds: number;
  connections_total: number;
  connections_bad_total: number;
  handshake_timeouts_total: number;
  configured_users: number;
}

interface SystemInfoData {
  [key: string]: unknown;
}

interface GatesData {
  startup_status?: string;
  startup_stage?: string;
  startup_progress_pct?: number;
  [key: string]: unknown;
}

interface UserTrafficData {
  total_octets: number;
  active_unique_ips: number;
}

const ENDPOINTS = ['/v1/health', '/v1/stats/summary', '/v1/system/info', '/v1/runtime/gates'];

export function DashboardPage() {
  const { data: wsData, errors, connected, refresh } = useWsSubscription('dashboard', ENDPOINTS, 5);

  const health = useEndpoint<HealthData>(wsData, '/v1/health');
  const summary = useEndpoint<SummaryData>(wsData, '/v1/stats/summary');
  const system = useEndpoint<SystemInfoData>(wsData, '/v1/system/info');
  const gates = useEndpoint<GatesData>(wsData, '/v1/runtime/gates');

  const { data: usersData } = usePolling<UserTrafficData[]>(
    () => telemt.get('/v1/users'),
    10000
  );

  const totalTraffic = useMemo(() => {
    if (!usersData) return 0;
    return usersData.reduce((sum, u) => sum + u.total_octets, 0);
  }, [usersData]);

  const totalActiveIPs = useMemo(() => {
    if (!usersData) return 0;
    return usersData.reduce((sum, u) => sum + u.active_unique_ips, 0);
  }, [usersData]);

  const isHealthy = health?.status === 'ok';
  const firstError = Object.values(errors)[0];

  return (
    <div>
      <Header title="Dashboard" refreshing={!connected} onRefresh={refresh} />

      <div className="p-4 lg:p-6 space-y-4 lg:space-y-6">
        {firstError && <ErrorAlert message={firstError} onRetry={refresh} />}

        {/* Health Banner */}
        <div
          className={`rounded-lg border p-3 lg:p-4 flex items-center gap-2 lg:gap-3 text-sm lg:text-base ${
            isHealthy
              ? 'bg-success/10 border-success/30'
              : 'bg-danger/10 border-danger/30'
          }`}
        >
          <StatusDot
            status={isHealthy ? 'ok' : 'error'}
            size="md"
            animated={!connected}
          />
          <span className={`font-medium ${isHealthy ? 'text-success' : 'text-danger'}`}>
            {isHealthy ? 'Telemt is running' : 'Telemt is unreachable'}
          </span>
          {!connected && (
            <span className="ml-auto text-xs text-warning bg-warning/15 px-2 py-1 rounded shrink-0">
              WS reconnecting...
            </span>
          )}
          {health?.read_only && (
            <span className="ml-auto text-xs text-warning bg-warning/15 px-2 py-1 rounded shrink-0">
              READ-ONLY
            </span>
          )}
        </div>

        {/* Startup Status */}
        {gates && (
          <StartupStatus
            status={gates.startup_status}
            stage={gates.startup_stage}
            progressPct={gates.startup_progress_pct}
          />
        )}

        {/* Metric Cards */}
        {summary && (
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 lg:gap-4">
            <MetricCard
              label="Uptime"
              value={formatUptime(summary.uptime_seconds)}
              icon={<Clock size={14} className="lg:w-4 lg:h-4" />}
            />
            <MetricCard
              label="Total Connections"
              value={formatNumber(summary.connections_total)}
              icon={<Activity size={14} className="lg:w-4 lg:h-4" />}
              variant="success"
            />
            <MetricCard
              label="Bad Connections"
              value={formatNumber(summary.connections_bad_total)}
              variant={summary.connections_bad_total > 0 ? 'warning' : 'default'}
              status={summary.connections_bad_total > 0 ? 'warn' : 'ok'}
            />
            <MetricCard
              label="Configured Users"
              value={summary.configured_users}
              icon={<Users size={14} className="lg:w-4 lg:h-4" />}
            />
            <MetricCard
              label="Active IPs"
              value={formatNumber(totalActiveIPs)}
              icon={<Globe size={14} className="lg:w-4 lg:h-4" />}
            />
            <MetricCard
              label="Total Traffic"
              value={formatBytes(totalTraffic)}
              icon={<ArrowUpDown size={14} className="lg:w-4 lg:h-4" />}
            />
          </div>
        )}

        {/* System Info */}
        {system && (
          <CollapsibleSection title="System Info" description="Информация о системе">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 lg:gap-3">
              {Object.entries(system).map(([key, value]) => (
                <div key={key}>
                  <div className="text-xs text-text-secondary">{key.replace(/_/g, ' ')}</div>
                  <div className="text-xs lg:text-sm text-text-primary truncate">
                    {typeof value === 'boolean' ? (
                      <StatusBadge status={value} />
                    ) : (
                      String(value ?? '-')
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

      </div>
    </div>
  );
}
