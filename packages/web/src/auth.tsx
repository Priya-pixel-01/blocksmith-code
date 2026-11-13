import { createContext, useContext, useEffect, useState } from 'react';
import {
  getCurrentUser,
  login as loginRequest,
  logout as logoutRequest,
  type CurrentUser,
} from './api.js';

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}
const AuthContext = createContext<AuthContextValue | null>(null);
let currentUserRequest: Promise<{ user: CurrentUser }> | null = null;

function loadCurrentUser(): Promise<{ user: CurrentUser }> {
  if (!currentUserRequest) {
    currentUserRequest = getCurrentUser().catch((error: unknown) => {
      currentUserRequest = null;
      throw error;
    });
  }
  return currentUserRequest;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    loadCurrentUser()
      .then((response) => setUser(response.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);
  const login = async (email: string, password: string) => {
    const response = await loginRequest(email, password);
    currentUserRequest = Promise.resolve(response);
    setUser(response.user);
  };
  const logout = async () => {
    await logoutRequest();
    currentUserRequest = null;
    setUser(null);
  };
  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider');
  return value;
}
