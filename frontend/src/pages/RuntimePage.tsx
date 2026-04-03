import { Header } from '@/components/layout/Header';
import { ErrorAlert } from '@/components/ErrorAlert';
import { useWsSubscription, useEndpoint } from '@/hooks/useWebSocket';
import type {
  ConnectionsData, PoolStateData, MeQualityData, UpstreamQualityData,
  NatStunData, MeSelftestData, EventsData, MinimalAllResponse,
} from '@/types/runtime';

import { GatesSection } from '@/pages/runtime/GatesSection';
import { ConnectionsSection } from '@/pages/runtime/ConnectionsSection';
import { MEPoolStateSection } from '@/pages/runtime/MEPoolStateSection';
import { MEQualitySection } from '@/pages/runtime/MEQualitySection';
import { UpstreamQualitySection } from '@/pages/runtime/UpstreamQualitySection';
import { NATSTUNSection } from '@/pages/runtime/NATSTUNSection';
import { MESelfTestSection } from '@/pages/runtime/MESelfTestSection';
import { StatisticsZeroSection } from '@/pages/runtime/StatisticsZeroSection';
import { MERuntimeSection } from '@/pages/runtime/MERuntimeSection';
import { NetworkPathSection } from '@/pages/runtime/NetworkPathSection';
import { RecentEventsSection } from '@/pages/runtime/RecentEventsSection';

const ENDPOINTS = [
  '/v1/runtime/gates',
  '/v1/runtime/me_pool_state',
  '/v1/runtime/me_quality',
  '/v1/runtime/upstream_quality',
  '/v1/runtime/nat_stun',
  '/v1/runtime/me-selftest',
  '/v1/runtime/connections/summary',
  '/v1/runtime/events/recent',
  '/v1/stats/zero/all',
  '/v1/stats/minimal/all',
];

export function RuntimePage() {
  const { data: wsData, errors, connected, refresh } = useWsSubscription('runtime', ENDPOINTS, 5);

  const gates = useEndpoint<Record<string, unknown>>(wsData, '/v1/runtime/gates');
  const pool = useEndpoint<PoolStateData>(wsData, '/v1/runtime/me_pool_state');
  const meQuality = useEndpoint<MeQualityData>(wsData, '/v1/runtime/me_quality');
  const upstreamQuality = useEndpoint<UpstreamQualityData>(wsData, '/v1/runtime/upstream_quality');
  const natStun = useEndpoint<NatStunData>(wsData, '/v1/runtime/nat_stun');
  const meSelftest = useEndpoint<MeSelftestData>(wsData, '/v1/runtime/me-selftest');
  const connections = useEndpoint<ConnectionsData>(wsData, '/v1/runtime/connections/summary');
  const events = useEndpoint<EventsData>(wsData, '/v1/runtime/events/recent');
  const zeroAll = useEndpoint<Record<string, unknown>>(wsData, '/v1/stats/zero/all');
  const minimalAll = useEndpoint<MinimalAllResponse>(wsData, '/v1/stats/minimal/all');

  const firstError = Object.values(errors)[0];

  return (
    <div>
      <Header title="Runtime" refreshing={!connected} onRefresh={refresh} />

      <div className="p-4 lg:p-6 space-y-4">
        {firstError && <ErrorAlert message={firstError} onRetry={refresh} />}

        <GatesSection gates={gates} />
        <ConnectionsSection data={connections} />
        <MEPoolStateSection data={pool} />
        <MEQualitySection data={meQuality} />
        <UpstreamQualitySection data={upstreamQuality} />
        <NATSTUNSection data={natStun} />
        <MESelfTestSection data={meSelftest} />
        <StatisticsZeroSection data={zeroAll} />
        <MERuntimeSection data={minimalAll?.data?.me_runtime ?? null} />
        <NetworkPathSection data={minimalAll?.data?.network_path ?? null} />
        <RecentEventsSection data={events} />
      </div>
    </div>
  );
}
