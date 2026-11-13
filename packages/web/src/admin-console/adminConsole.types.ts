export type AdminTabKey = 'users' | 'projects' | 'tools' | 'apiKeys' | 'auditLogs';

export type User = {
  id: string;
  email: string;
  admin: boolean;
  created: string;
  updated_at: string;
};

export type Tool = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  url: string;
};

export type Project = {
  id: string;
  name: string;
  tool_id: string;
  created: string;
  created_by_admin_id?: string;
};

export type ProjectMember = {
  id: string;
  user_id: string;
  user: string;
  role: string;
  added: string;
};

export type AvailableUser = {
  id: string;
  email: string;
};

export type ApiKey = {
  id: string;
  projectId: string;
  projectName?: string;
  key: string;
  lastUpdated: string;
  isActive: boolean;
};

export type ApiKeyStatus = {
  id?: string;
  projectId: string;
  projectName?: string;
  isConfigured: boolean;
  lastUpdated?: string;
  isActive: boolean;
};

export type AuditLog = {
  id: string;
  adminId: string;
  adminEmail?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  timestamp: string;
  details: Record<string, unknown> | null;
  ipAddress?: string | null;
};

export type TableColumn<T extends Record<string, unknown>> = {
  key: keyof T | string;
  label: string;
  render?: (row: T) => unknown;
};
