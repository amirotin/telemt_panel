import { useState, useCallback, useMemo, useEffect } from 'react';
import { Header } from '@/components/layout/Header';
import { ErrorAlert } from '@/components/ErrorAlert';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { UserFormDialog } from '@/components/UserFormDialog';
import { UserCard } from '@/components/UserCard';
import { ProxyLinkButtons } from '@/components/ProxyLinkButtons';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { usePolling } from '@/hooks/usePolling';
import { telemt, panelApi, ApiError } from '@/lib/api';
import { Link } from 'react-router-dom';
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown, ArrowUpDown, Search, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { useQuota, resetUserQuota, type QuotaEntry } from '@/hooks/useQuota';
import { QuotaBar } from '@/components/QuotaBar';
import { buildProxyLinks, type UserLinks, type WebProfile } from './usersPage.helpers';

type SortKey = 'username' | 'current_connections' | 'active_unique_ips' | 'total_octets' | 'expiration_rfc3339';
type SortDir = 'asc' | 'desc';

interface UserInfo {
  username: string;
  user_ad_tag?: string;
  max_tcp_conns?: number;
  expiration_rfc3339?: string;
  data_quota_bytes?: number;
  max_unique_ips?: number;
  current_connections: number;
  active_unique_ips: number;
  recent_unique_ips: number;
  total_octets: number;
  active_unique_ips_list?: string[];
  recent_unique_ips_list?: string[];
  links?: UserLinks;
}

function QuotaCell({ user, entry }: { user: UserInfo; entry?: QuotaEntry }) {
  const limit = entry?.data_quota_bytes || user.data_quota_bytes || 0;
  if (entry && limit > 0) {
    return <QuotaBar used={entry.used_bytes} limit={limit} />;
  }
  if (user.data_quota_bytes) {
    return <Badge variant="outline">{formatBytes(user.data_quota_bytes)}</Badge>;
  }
  return <span className="text-text-secondary">-</span>;
}

export function UsersPage() {
  const { data: users, error, loading, refresh } = usePolling<UserInfo[]>(
    () => telemt.get('/v1/users'),
    10000
  );
  const { quotaByUser, supported: quotaSupported, refresh: refreshQuota } = useQuota(10000);

  const [sortKey, setSortKey] = useState<SortKey>('username');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);

  // WEB proxy vhost profiles (Telemt 3.5.2+); static config, fetched once.
  // The Users API does not return tg://webproxy links — see usersPage.helpers.
  const [webProfiles, setWebProfiles] = useState<WebProfile[]>([]);
  useEffect(() => {
    panelApi
      .get<{ available: boolean; enabled: boolean; profiles: WebProfile[] }>('/telemt/web/profiles')
      .then((d) => {
        if (d.available && d.enabled) setWebProfiles(d.profiles);
      })
      .catch(() => {});
  }, []);

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return key;
      }
      setSortDir('asc');
      return key;
    });
  }, []);

  const filteredUsers = useMemo(() => {
    if (!users) return [];
    if (!search.trim()) return users;
    const q = search.trim().toLowerCase();
    return users.filter((u) => u.username.toLowerCase().includes(q));
  }, [users, search]);

  const sortedUsers = useMemo(() => {
    return [...filteredUsers].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'username':
          cmp = a.username.localeCompare(b.username);
          break;
        case 'current_connections':
          cmp = a.current_connections - b.current_connections;
          break;
        case 'active_unique_ips':
          cmp = a.active_unique_ips - b.active_unique_ips;
          break;
        case 'total_octets':
          cmp = a.total_octets - b.total_octets;
          break;
        case 'expiration_rfc3339': {
          const ta = a.expiration_rfc3339 ? new Date(a.expiration_rfc3339).getTime() : 0;
          const tb = b.expiration_rfc3339 ? new Date(b.expiration_rfc3339).getTime() : 0;
          cmp = ta - tb;
          break;
        }
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filteredUsers, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedUsers.length / perPage));
  const safePage = Math.min(page, totalPages);
  const pagedUsers = useMemo(() => {
    const start = (safePage - 1) * perPage;
    return sortedUsers.slice(start, start + perPage);
  }, [sortedUsers, safePage, perPage]);

  // Reset page when search or perPage changes
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const handlePerPageChange = useCallback((value: number) => {
    setPerPage(value);
    setPage(1);
  }, []);

  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<UserInfo | null>(null);
  const [deleteUser, setDeleteUser] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [resetUser, setResetUser] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetAllOpen, setResetAllOpen] = useState(false);
  const [resettingAll, setResettingAll] = useState(false);
  const [actionError, setActionError] = useState('');
  const [userDefaults, setUserDefaults] = useState<{
    user_ad_tag?: string;
    max_tcp_conns?: number;
    data_quota_bytes?: number;
    max_unique_ips?: number;
    expiration_rfc3339?: string;
  }>({});

  useEffect(() => {
    panelApi.get<typeof userDefaults>('/users/defaults')
      .then(setUserDefaults)
      .catch((e) => console.warn('Failed to load user defaults:', e));
  }, []);

  const handleCreate = useCallback(async (data: Record<string, unknown>) => {
    await telemt.post('/v1/users', data);
    refresh();
  }, [refresh]);

  const handleEdit = useCallback(async (data: Record<string, unknown>) => {
    if (!editUser) return;
    await telemt.patch(`/v1/users/${editUser.username}`, data);
    refresh();
  }, [editUser, refresh]);

  const handleDelete = useCallback(async () => {
    if (!deleteUser) return;
    setDeleting(true);
    setActionError('');
    try {
      await telemt.delete(`/v1/users/${deleteUser}`);
      setDeleteUser(null);
      refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }, [deleteUser, refresh]);

  const handleResetQuota = useCallback(async () => {
    if (!resetUser) return;
    setResetting(true);
    setActionError('');
    try {
      await resetUserQuota(resetUser);
      setResetUser(null);
      refresh();
      refreshQuota();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Reset failed');
    } finally {
      setResetting(false);
    }
  }, [resetUser, refresh, refreshQuota]);

  // Users with a quota configured — the targets for a bulk reset.
  const quotaUsers = useMemo(
    () => (users ?? []).filter((u) => !!u.data_quota_bytes),
    [users],
  );

  // No bulk endpoint exists, so reset each user's quota with its own request.
  const handleResetAllQuotas = useCallback(async () => {
    setResettingAll(true);
    setActionError('');
    const failed: string[] = [];
    for (const u of quotaUsers) {
      try {
        await resetUserQuota(u.username);
      } catch {
        failed.push(u.username);
      }
    }
    setResettingAll(false);
    setResetAllOpen(false);
    refresh();
    refreshQuota();
    if (failed.length) {
      setActionError(`Failed to reset quota for ${failed.length} user(s): ${failed.join(', ')}`);
    }
  }, [quotaUsers, refresh, refreshQuota]);

  return (
    <div className="min-h-screen">
      <Header title="Users" refreshing={loading} onRefresh={refresh} />

      <div className="p-4 lg:p-6 space-y-4">
        {error && <ErrorAlert message={error.message} onRetry={refresh} />}
        {actionError && <ErrorAlert message={actionError} />}

        <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-sm">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
            <input
              type="text"
              placeholder="Search users..."
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full pl-9 pr-3 py-2 min-h-[44px] rounded-lg border border-border bg-surface text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
          </div>
          <div className="flex items-center gap-2">
            {quotaSupported && quotaUsers.length > 0 && (
              <Button variant="outline" onClick={() => setResetAllOpen(true)}>
                <RotateCcw size={16} className="mr-1.5" />
                <span className="hidden sm:inline">Reset all quotas</span>
                <span className="sm:hidden">Reset all</span>
              </Button>
            )}
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={16} className="mr-1.5" />
              <span className="hidden sm:inline">Create User</span>
              <span className="sm:hidden">Create</span>
            </Button>
          </div>
        </div>

        {/* Mobile Sort Bar */}
        <div className="lg:hidden flex items-center justify-between gap-2 bg-surface p-2 sm:p-3 rounded-lg border border-border">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-sm font-medium text-text-secondary whitespace-nowrap">Sort by:</span>
            <select
              value={sortKey}
              onChange={(e) => toggleSort(e.target.value as SortKey)}
              aria-label="Sort by"
              className="flex-1 min-w-0 min-h-[44px] bg-background text-text-primary rounded-md px-2 py-1.5 text-sm border border-border focus:border-accent focus:outline-none"
            >
              <option value="username">Username</option>
              <option value="current_connections">Connections</option>
              <option value="active_unique_ips">Active IPs</option>
              <option value="total_octets">Traffic</option>
              <option value="expiration_rfc3339">Expiration</option>
            </select>
          </div>
          <button
            onClick={() => toggleSort(sortKey)}
            aria-label={sortDir === 'asc' ? 'Sort Descending' : 'Sort Ascending'}
            title={sortDir === 'asc' ? 'Sort Descending' : 'Sort Ascending'}
            className="p-2.5 rounded-md border border-border bg-background hover:bg-surface-hover text-text-secondary transition-colors flex-shrink-0"
          >
            {sortDir === 'asc' ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
          </button>
        </div>

        {/* Desktop Table */}
        <div className="hidden lg:block border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('username')}>
                    <span className="inline-flex items-center gap-1">
                      Username
                      {sortKey === 'username' ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="text-text-secondary/40" />}
                    </span>
                  </TableHead>
                  <TableHead>Proxy Links</TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('current_connections')}>
                    <span className="inline-flex items-center gap-1">
                      Connections
                      {sortKey === 'current_connections' ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="text-text-secondary/40" />}
                    </span>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('active_unique_ips')}>
                    <span className="inline-flex items-center gap-1">
                      Active IPs
                      {sortKey === 'active_unique_ips' ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="text-text-secondary/40" />}
                    </span>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('total_octets')}>
                    <span className="inline-flex items-center gap-1">
                      Traffic
                      {sortKey === 'total_octets' ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="text-text-secondary/40" />}
                    </span>
                  </TableHead>
                  <TableHead>Quota</TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('expiration_rfc3339')}>
                    <span className="inline-flex items-center gap-1">
                      Expiration
                      {sortKey === 'expiration_rfc3339' ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="text-text-secondary/40" />}
                    </span>
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-text-secondary py-8">
                      {search ? 'No users found' : 'No users configured'}
                    </TableCell>
                  </TableRow>
                ) : (
                  pagedUsers.map((u) => {
                    const hasConns = u.current_connections > 0;

                    return (
                      <TableRow key={u.username} className={hasConns ? 'bg-success/5 hover:bg-success/10' : ''}>
                        <TableCell className="font-medium">
                          <Link to={`/users/${u.username}`} className="text-accent hover:underline">{u.username}</Link>
                        </TableCell>
                        <TableCell>
                          <ProxyLinkButtons links={buildProxyLinks(u.links, u.username, webProfiles)} />
                        </TableCell>
                        <TableCell>
                          <Badge variant={u.current_connections > 0 ? 'default' : 'outline'}>
                            {u.current_connections}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{u.active_unique_ips}</span>
                          {u.max_unique_ips != null && u.max_unique_ips > 0 && (
                            <span className="text-xs text-text-secondary ml-1">/ {u.max_unique_ips}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{formatBytes(u.total_octets)}</Badge>
                        </TableCell>
                        <TableCell>
                          <QuotaCell user={u} entry={quotaByUser.get(u.username)} />
                        </TableCell>
                        <TableCell>
                          {u.expiration_rfc3339 ? (
                            <span className="text-xs">{new Date(u.expiration_rfc3339).toLocaleDateString()}</span>
                          ) : (
                            <span className="text-text-secondary">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {quotaSupported && !!u.data_quota_bytes && (
                              <button
                                onClick={() => setResetUser(u.username)}
                                title="Reset quota"
                                className="p-1.5 rounded text-text-secondary hover:text-accent hover:bg-surface-hover"
                              >
                                <RotateCcw size={14} />
                              </button>
                            )}
                            <button
                              onClick={() => setEditUser(u)}
                              className="p-1.5 rounded text-text-secondary hover:text-accent hover:bg-surface-hover"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => setDeleteUser(u.username)}
                              className="p-1.5 rounded text-text-secondary hover:text-danger hover:bg-surface-hover"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Mobile Cards */}
        <div className="lg:hidden space-y-3">
          {pagedUsers.length === 0 ? (
            <div className="text-center text-text-secondary py-8 bg-surface border border-border rounded-lg">
              {search ? 'No users found' : 'No users configured'}
            </div>
          ) : (
            pagedUsers.map((u) => {
              return (
                <UserCard
                  key={u.username}
                  username={u.username}
                  detailHref={`/users/${u.username}`}
                  connections={u.current_connections}
                  activeUniqueIps={u.active_unique_ips}
                  totalTraffic={u.total_octets}
                  online={u.current_connections > 0}
                  links={buildProxyLinks(u.links, u.username, webProfiles)}
                  onEdit={() => setEditUser(u)}
                  onDelete={() => setDeleteUser(u.username)}
                  quotaUsed={quotaByUser.get(u.username)?.used_bytes}
                  quotaLimit={quotaByUser.get(u.username)?.data_quota_bytes}
                  onResetQuota={
                    quotaSupported && !!u.data_quota_bytes
                      ? () => setResetUser(u.username)
                      : undefined
                  }
                />
              );
            })
          )}
        </div>

        {/* Pagination */}
        {sortedUsers.length > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-text-secondary">
            <div className="flex items-center gap-2">
              <span>Show</span>
              <select
                value={perPage}
                onChange={(e) => handlePerPageChange(Number(e.target.value))}
                className="rounded border border-border bg-surface px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
              >
                {[10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <span>of {sortedUsers.length}{search && ` (filtered from ${users?.length ?? 0})`}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="p-2.5 rounded border border-border bg-surface hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={16} />
              </button>
              <span>{safePage} / {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="p-2.5 rounded border border-border bg-surface hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      <UserFormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreate}
        initialData={userDefaults}
        mode="create"
      />

      <UserFormDialog
        open={!!editUser}
        onClose={() => setEditUser(null)}
        onSubmit={handleEdit}
        initialData={editUser ?? undefined}
        mode="edit"
      />

      <ConfirmDialog
        open={!!deleteUser}
        onClose={() => setDeleteUser(null)}
        onConfirm={handleDelete}
        title="Delete User"
        message={`Are you sure you want to delete user "${deleteUser}"? This action cannot be undone.`}
        loading={deleting}
      />

      <ConfirmDialog
        open={!!resetUser}
        onClose={() => setResetUser(null)}
        onConfirm={handleResetQuota}
        title="Reset quota"
        message={`Reset the data-quota counter for "${resetUser}"? Used traffic will be set back to zero.`}
        confirmLabel="Reset"
        loadingLabel="Resetting..."
        confirmVariant="default"
        loading={resetting}
      />

      <ConfirmDialog
        open={resetAllOpen}
        onClose={() => setResetAllOpen(false)}
        onConfirm={handleResetAllQuotas}
        title="Reset all quotas"
        message={`Reset the data-quota counter for all ${quotaUsers.length} user(s) with a quota? Used traffic will be set back to zero for each. This sends one request per user.`}
        confirmLabel="Reset all"
        loadingLabel="Resetting..."
        confirmVariant="default"
        loading={resettingAll}
      />
    </div>
  );
}
