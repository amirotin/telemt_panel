import { useState, useCallback, useMemo } from 'react';
import { Header } from '@/components/layout/Header';
import { ErrorAlert } from '@/components/ErrorAlert';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { UserFormDialog } from '@/components/UserFormDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { usePolling } from '@/hooks/usePolling';
import { telemt, ApiError } from '@/lib/api';
import { Link } from 'react-router-dom';
import { Copy, Plus, Pencil, Trash2, Check, ArrowUp, ArrowDown, ArrowUpDown, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatBytes } from '@/lib/utils';

type SortKey = 'username' | 'current_connections' | 'active_unique_ips' | 'total_octets' | 'expiration_rfc3339';
type SortDir = 'asc' | 'desc';

interface UserLinks {
  classic?: string[];
  secure?: string[];
  tls?: string[];
}

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

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts (HTTP)
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore copy failures
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-background hover:bg-surface-hover text-text-secondary hover:text-text-primary transition-colors"
      title={label || 'Copy'}
    >
      {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
      {label && <span>{copied ? 'Copied' : label}</span>}
    </button>
  );
}

interface LinkEntry {
  url: string;
  label: string;
}

function collectLinks(links?: UserLinks): LinkEntry[] {
  const result: LinkEntry[] = [];
  if (!links) return result;
  if (links.tls) {
    for (const url of links.tls) result.push({ url, label: 'TLS' });
  }
  if (links.secure) {
    for (const url of links.secure) result.push({ url, label: 'Secure' });
  }
  if (links.classic) {
    for (const url of links.classic) result.push({ url, label: 'Classic' });
  }
  return result;
}

export function UsersPage() {
  const { data: users, error, loading, refresh } = usePolling<UserInfo[]>(
    () => telemt.get('/v1/users'),
    10000
  );

  const [sortKey, setSortKey] = useState<SortKey>('username');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);

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
  const [actionError, setActionError] = useState('');

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
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} className="mr-1.5" />
            <span className="hidden sm:inline">Create User</span>
            <span className="sm:hidden">Create</span>
          </Button>
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
                    const allLinks = collectLinks(u.links);
                    const hasConns = u.current_connections > 0;

                    return (
                      <TableRow key={u.username} className={hasConns ? 'bg-success/5 hover:bg-success/10' : ''}>
                        <TableCell className="font-medium">
                          <Link to={`/users/${u.username}`} className="text-accent hover:underline">{u.username}</Link>
                        </TableCell>
                        <TableCell>
                          {allLinks.length > 0 ? (
                            <div className="flex flex-col gap-1">
                              {allLinks.map((link, i) => (
                                <div key={i} className="flex items-center gap-1">
                                  <CopyButton text={link.url} label={link.label} />
                                  <CopyButton text={link.url.replace('tg://proxy', 'https://t.me/proxy')} label="t.me" />
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span className="text-text-secondary text-xs">No links</span>
                          )}
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
                          {u.data_quota_bytes ? (
                            <Badge variant="outline">{formatBytes(u.data_quota_bytes)}</Badge>
                          ) : (
                            <span className="text-text-secondary">-</span>
                          )}
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
              const allLinks = collectLinks(u.links);
              const hasConns = u.current_connections > 0;

              return (
                <div key={u.username} className={`bg-surface border rounded-lg p-3 space-y-3 ${hasConns ? 'border-success/40 bg-success/5' : 'border-border'}`}>
                  <div className="flex items-center justify-between">
                    <Link to={`/users/${u.username}`} className="font-medium text-accent hover:underline">{u.username}</Link>
                    <div className="flex gap-1">
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
                  </div>

                  {allLinks.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-xs text-text-secondary">Proxy Links</div>
                      {allLinks.map((link, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <CopyButton text={link.url} label={link.label} />
                          <CopyButton text={link.url.replace('tg://proxy', 'https://t.me/proxy')} label="t.me" />
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-text-secondary">Connections</div>
                      <Badge variant={u.current_connections > 0 ? 'default' : 'outline'} className="mt-1">
                        {u.current_connections}
                      </Badge>
                    </div>
                    <div>
                      <div className="text-text-secondary">Active IPs</div>
                      <div className="mt-1">
                        {u.active_unique_ips}
                        {u.max_unique_ips != null && u.max_unique_ips > 0 && (
                          <span className="text-text-secondary ml-1">/ {u.max_unique_ips}</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-text-secondary">Traffic</div>
                      <Badge variant="outline" className="mt-1">{formatBytes(u.total_octets)}</Badge>
                    </div>
                    <div>
                      <div className="text-text-secondary">Quota</div>
                      <div className="mt-1">
                        {u.data_quota_bytes ? (
                          <Badge variant="outline">{formatBytes(u.data_quota_bytes)}</Badge>
                        ) : (
                          <span className="text-text-secondary">-</span>
                        )}
                      </div>
                    </div>
                    {u.expiration_rfc3339 && (
                      <div className="col-span-2">
                        <div className="text-text-secondary">Expiration</div>
                        <div className="mt-1">{new Date(u.expiration_rfc3339).toLocaleDateString()}</div>
                      </div>
                    )}
                  </div>
                </div>
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
                className="p-1.5 rounded border border-border bg-surface hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={16} />
              </button>
              <span>{safePage} / {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="p-1.5 rounded border border-border bg-surface hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
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
    </div>
  );
}
