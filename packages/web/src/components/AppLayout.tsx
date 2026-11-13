import { useEffect, useState } from 'react';
import { LogOut, User } from 'lucide-react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { clearCachedTools, getCachedTools, type Tool } from '../api.js';
import { useAuth } from '../auth.js';

const BLOCKSMITH_TOOL_ID = 'acbee42e-f97d-411c-813e-8405fee19f73';

function formatToolName(name: string): string {
  const normalizedName = name.trim().toLowerCase();
  return normalizedName.charAt(0).toUpperCase() + normalizedName.slice(1);
}

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [tools, setTools] = useState<Tool[]>([]);

  useEffect(() => {
    if (!user) {
      clearCachedTools();
      setTools([]);
      return;
    }

    let active = true;
    getCachedTools()
      .then((availableTools) => {
        if (active) setTools(availableTools);
      })
      .catch(() => {
        if (active) setTools([]);
      });

    return () => {
      active = false;
    };
  }, [user]);

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="app-header__brand">
          <span className="app-header__mark">B</span>
          Blocksmith
        </Link>

        <nav className="app-header__nav">
          <Link to="/">Workspace</Link>

          {/* Admin-only navigation */}
          {user?.isAdmin && (
            <>
              <Link to="/adminConsole">Admin Console</Link>
            </>
          )}

          {tools.length > 0 && (
            <details className="app-header__tools">
              <summary className="app-header__tools-trigger">Tools</summary>

              <div className="app-header__tools-menu">
                {tools.map((tool) =>
                  tool.id === BLOCKSMITH_TOOL_ID ? (
                    <span
                      key={tool.id}
                      className="app-header__tools-menu-current"
                      aria-disabled="true"
                      title="You are already using this app"
                    >
                      {formatToolName(tool.name)} (Current)
                    </span>
                  ) : (
                    <a
                      key={tool.id}
                      href={tool.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {formatToolName(tool.name)}
                    </a>
                  ),
                )}
              </div>
            </details>
          )}

          {/* User profile */}
          <details className="app-header__user">
            <summary className="app-header__user-trigger">
              <User size={16} aria-hidden="true" />
              <span>{user?.email}</span>
            </summary>

            <div className="app-header__user-menu">
              <div className="app-header__user-email">{user?.email}</div>

              <div className="app-header__user-role">
                Role: <strong>{user?.isAdmin ? 'Admin' : 'User'}</strong>
              </div>
            </div>
          </details>

          <button
            type="button"
            className="app-header__logout"
            onClick={handleLogout}
            title="Sign out"
          >
            <LogOut size={15} aria-hidden="true" />
            Sign out
          </button>
        </nav>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
