import React, { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../api/client';

export interface User {
  id: number;
  username: string;
  email?: string;
  nickname?: string;
  avatar_url?: string;
  role: 'user' | 'admin';
  status: 'pending' | 'approved' | 'rejected' | 'banned';
  token_secret: string;
  calendar_token?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
  updateUser: (fields: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function readCachedAuth(): { token: string | null; user: User | null; hasRawToken: boolean } {
  const savedToken = localStorage.getItem('clawbot_token');
  const savedUserRaw = localStorage.getItem('clawbot_user');
  if (!savedToken || !savedUserRaw) {
    return { token: savedToken, user: null, hasRawToken: Boolean(savedToken) };
  }
  try {
    const parsed = JSON.parse(savedUserRaw) as User | null;
    if (!parsed || typeof parsed.id !== 'number' || parsed.status !== 'approved') {
      return { token: savedToken, user: null, hasRawToken: true };
    }
    return { token: savedToken, user: parsed, hasRawToken: true };
  } catch {
    localStorage.removeItem('clawbot_user');
    return { token: savedToken, user: null, hasRawToken: true };
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [initialAuth] = useState(() => readCachedAuth());
  const [user, setUser] = useState<User | null>(initialAuth.user);
  const [token, setToken] = useState<string | null>(initialAuth.token);
  const [loading, setLoading] = useState<boolean>(
    initialAuth.hasRawToken && !initialAuth.user
  );

  const refreshUser = async () => {
    if (!localStorage.getItem('clawbot_token')) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.get('/auth/me');
      setUser(res.data.user);
      localStorage.setItem('clawbot_user', JSON.stringify(res.data.user));
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403 || !localStorage.getItem('clawbot_token')) {
        setUser(null);
        setToken(null);
        localStorage.removeItem('clawbot_token');
        localStorage.removeItem('clawbot_user');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshUser();
  }, []);

  const login = (newToken: string, newUser: User) => {
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem('clawbot_token', newToken);
    localStorage.setItem('clawbot_user', JSON.stringify(newUser));
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('clawbot_token');
    localStorage.removeItem('clawbot_user');
  };

  const updateUser = (fields: Partial<User>) => {
    setUser((prev) => {
      if (!prev) return null;
      const updated = { ...prev, ...fields };
      localStorage.setItem('clawbot_user', JSON.stringify(updated));
      return updated;
    });
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, refreshUser, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
};
