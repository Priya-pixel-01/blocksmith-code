import type {
  ApiKey,
  ApiKeyStatus,
  AuditLog,
  Project,
  ProjectMember,
  AvailableUser,
  Tool,
  User,
} from './adminConsole.types';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const initialApiKeys: ApiKey[] = [];

export const initialAuditLogs: AuditLog[] = [];

export const adminConsoleService = {
  async getUsers(): Promise<User[]> {
    return request<User[]>('/admin/users');
  },

  async getTools(): Promise<Tool[]> {
    return request<Tool[]>('/admin/tools');
  },

  async createTool(payload: { name: string; description: string; url: string }): Promise<Tool> {
    return request<Tool>('/admin/tools', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async updateTool(id: string, payload: { description: string; url: string }): Promise<Tool> {
    return request<Tool>(`/admin/tools/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  async deleteTool(id: string): Promise<void> {
    await request<void>(`/admin/tools/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async getProjects(toolId: string): Promise<Project[]> {
    return request<Project[]>(`/admin/projects?toolId=${encodeURIComponent(toolId)}`);
  },

  async getMembers(projectId: string): Promise<ProjectMember[]> {
    return request<ProjectMember[]>(`/admin/projects/${encodeURIComponent(projectId)}/members`);
  },

  async getAvailableUsers(projectId: string): Promise<AvailableUser[]> {
    return request<AvailableUser[]>(`/admin/projects/${encodeURIComponent(projectId)}/available-users`);
  },

  async getApiKeys(): Promise<ApiKey[]> {
    return Promise.resolve(initialApiKeys);
  },

  async getAuditLogs(): Promise<AuditLog[]> {
    return request<AuditLog[]>('/admin/audit-logs');
  },

  async getApiKeyStatus(projectId: string, signal?: AbortSignal): Promise<ApiKeyStatus> {
    return request<ApiKeyStatus>(`/admin/api-keys/${encodeURIComponent(projectId)}`, { signal });
  },

  async updateApiKey(projectId: string, apiKey: string): Promise<ApiKeyStatus> {
    return request<ApiKeyStatus>(`/admin/api-keys/${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
  },

  async createUser(payload: {
    email: string;
    password: string;
    isAdmin: boolean;
    toolIds: string[];
  }): Promise<User> {
    return request<User>('/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // User clicks Delete -> send the user's ID and wait for both database deletes to finish.
  async deleteUser(id: string): Promise<void> {
    await request<void>(`/admin/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async createProject(payload: { name: string; toolId: string }): Promise<Project> {
    return request<Project>('/admin/projects', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async deleteProject(id: string): Promise<void> {
    await request<void>(`/admin/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async createMember(projectId: string, payload: { userId: string; role: string }): Promise<ProjectMember> {
    return request<ProjectMember>(`/admin/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async deleteMember(projectId: string, userId: string): Promise<void> {
    await request<void>(`/admin/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
  },
};
