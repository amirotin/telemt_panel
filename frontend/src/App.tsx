import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthContext, useAuthProvider, useAuth } from '@/hooks/useAuth';
import { WsContext, useWsProvider } from '@/hooks/useWebSocket';
import { ThemeContext, useThemeProvider } from '@/hooks/useTheme';
import { AppLayout } from '@/components/layout/AppLayout';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { UsersPage } from '@/pages/UsersPage';
import { UserDetailPage } from '@/pages/UserDetailPage';
import { RuntimePage } from '@/pages/RuntimePage';
import { SecurityPage } from '@/pages/SecurityPage';
import { UpstreamsPage } from '@/pages/UpstreamsPage';
import { UpdatePage } from '@/pages/UpdatePage';
import { ConfigPage } from '@/pages/ConfigPage';
import { LogsPage } from '@/pages/LogsPage';
import { TelegramPage } from '@/pages/TelegramPage';

function AuthenticatedApp() {
  const { username, loading } = useAuth();
  const ws = useWsProvider();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }

  if (!username) {
    return <Navigate to="/login" replace />;
  }

  return (
    <WsContext.Provider value={ws}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/users/:username" element={<UserDetailPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/runtime" element={<RuntimePage />} />
          <Route path="/security" element={<SecurityPage />} />
          <Route path="/upstreams" element={<UpstreamsPage />} />
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/telegram" element={<TelegramPage />} />
          <Route path="/update" element={<UpdatePage />} />
          <Route path="/logs" element={<LogsPage />} />
        </Route>
      </Routes>
    </WsContext.Provider>
  );
}

export default function App() {
  const auth = useAuthProvider();
  const themeCtx = useThemeProvider();

  return (
    <ThemeContext.Provider value={themeCtx}>
      <AuthContext.Provider value={auth}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<AuthenticatedApp />} />
        </Routes>
      </AuthContext.Provider>
    </ThemeContext.Provider>
  );
}
