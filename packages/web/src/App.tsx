import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.js';
import { AppLayout } from './components/AppLayout.js';
import { WorkspacePage } from './pages/WorkspacePage.js';
import { NewBatchPage } from './pages/NewBatchPage.js';
import { JobBoardPage } from './pages/JobBoardPage.js';
import { JobDetailPage } from './pages/JobDetailPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { AdminConsolePage } from './pages/AdminConsolePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { AccessDeniedPage } from './pages/AccessDeniedPage.js';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedLayout />}>
            <Route element={<AppLayout />}>
              <Route path="/" element={<WorkspacePage />} />
              <Route path="/adminConsole" element={<AdminConsolePage />} />
              <Route
                path="/workspace/:workspaceId/new-batch"
                element={<NewBatchPage />}
              />
              <Route path="/batch/:batchId" element={<JobBoardPage />} />
              <Route path="/jobs/:jobId" element={<JobDetailPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

function ProtectedLayout() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!user)
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!user.isAdmin && !user.tools.includes('blocksmith'))
    return <AccessDeniedPage />;
  return <Outlet />;
}
