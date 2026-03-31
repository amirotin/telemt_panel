import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, Activity, Shield, Network, Settings, ArrowUpCircle, ScrollText, LogOut, X, Sun, Moon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/hooks/useTheme';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/users', icon: Users, label: 'Users' },
  { to: '/runtime', icon: Activity, label: 'Runtime' },
  { to: '/security', icon: Shield, label: 'Security' },
  { to: '/upstreams', icon: Network, label: 'Upstreams & DCs' },
  { to: '/config', icon: Settings, label: 'Configuration' },
  { to: '/update', icon: ArrowUpCircle, label: 'Update' },
  { to: '/logs', icon: ScrollText, label: 'Logs' },
];

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ isOpen = true, onClose }: SidebarProps) {
  const { logout, username } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "w-60 h-dvh bg-surface border-r border-border flex flex-col fixed left-0 top-0 z-50 transition-transform duration-300",
        "lg:translate-x-0",
        isOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h1 className="text-lg font-bold text-text-primary tracking-tight">
            Telemt Panel
          </h1>
          <button
            onClick={onClose}
            className="lg:hidden p-1 hover:bg-surface-hover rounded"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                  isActive
                    ? 'bg-accent/15 text-accent'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                )
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-border">
          <div className="text-xs text-text-secondary mb-2 px-3 truncate">
            {username}
          </div>
          <button
            onClick={toggleTheme}
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-surface-hover w-full transition-colors"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <a
            href="https://github.com/amirotin/telemt_panel"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-surface-hover w-full transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
            GitHub
          </a>
          <button
            onClick={logout}
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-text-secondary hover:text-danger hover:bg-surface-hover w-full transition-colors"
          >
            <LogOut size={18} />
            Logout
          </button>
        </div>
      </aside>
    </>
  );
}

// Mobile bottom navigation
export function BottomNav() {
  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/users', icon: Users, label: 'Users' },
    { to: '/runtime', icon: Activity, label: 'Runtime' },
    { to: '/upstreams', icon: Network, label: 'More' },
  ];

  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-surface border-t border-border z-30 safe-area-inset-bottom">
      <div className="flex items-center justify-around px-2 py-2">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-1 px-3 py-1.5 rounded-md text-xs transition-colors min-w-0',
                isActive
                  ? 'text-accent'
                  : 'text-text-secondary'
              )
            }
          >
            <Icon size={20} />
            <span className="truncate max-w-full">{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
