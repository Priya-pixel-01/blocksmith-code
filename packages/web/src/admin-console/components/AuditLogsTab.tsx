import { AdminConsoleTable } from '../AdminConsoleTable';
import type { AuditLog, TableColumn } from '../adminConsole.types';

type AuditLogsTabProps = {
  auditLogs: AuditLog[];
  loading: boolean;
  error: string | null;
};

export function AuditLogsTab({ auditLogs, loading, error }: AuditLogsTabProps) {
  const formatDetails = (details: Record<string, unknown> | null): string => {
    if (!details) return '-';
    try {
      return JSON.stringify(details, null, 2);
    } catch {
      return String(details);
    }
  };

  const formatTimestamp = (timestamp: string): string => {
    try {
      const date = new Date(timestamp);
      return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    } catch {
      return timestamp;
    }
  };

  const columns: TableColumn<AuditLog>[] = [
    // {
    //   key: 'id',
    //   label: 'ID',
    //   render: (log) => `${log.id.substring(0, 8)}...`,
    // },
    {
      key: 'timestamp',
      label: 'Timestamp',
      render: (log) => formatTimestamp(log.timestamp),
    },
    {
      key: 'adminId',
      label: 'Admin Details (ID and Mail)',
      render: (log) => (
        <span className="admin-console__hover-value">
          {/* {log.adminId.substring(0, 8)}... */}
          <span className="admin-console__hover-tooltip" role="tooltip">
            <span>Admin ID: {log.adminId}</span>
            <span>Admin Email: {log.adminEmail ?? 'Unavailable'}</span>
          </span>
        </span>
      ),
    },
    // { key: 'adminEmail', label: 'Admin/User' },
    {
      key: 'action',
      label: 'Action',
      render: (log) => (
        <button type="button" className="btn btn--secondary btn--sm">
          {log.action.replace(/_/g, ' ')}
        </button>
      ),
    },
    // { key: 'resourceType', label: 'Resource Type' },
    {
      key: 'resourceId',
      label: 'Resource Details (ID and Type)',
      render: (log) => (
        <span className="admin-console__hover-value">
          {/* {log.resourceId.substring(0, 8)}... */}
          <span className="admin-console__hover-tooltip" role="tooltip">
            <span>Resource ID: {log.resourceId}</span>
            <span>Resource Type: {log.resourceType}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'details',
      label: 'Details',
      render: (log) => (
        <details style={{ cursor: 'pointer' }}>
          <summary
            style={{ cursor: 'pointer', color: 'var(--color-blue-600)' }}
          >
            View
          </summary>
          <pre
            style={{
              marginTop: 'var(--space-2)',
              fontSize: '0.75rem',
              maxWidth: '400px',
              overflow: 'auto',
              backgroundColor: 'var(--color-gray-50)',
              padding: 'var(--space-2)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {formatDetails(log.details)}
          </pre>
        </details>
      ),
    },
  ];

  return (
    <div className="admin-console__section">
      <AdminConsoleTable
        title="Audit Logs"
        actionText=""
        data={auditLogs}
        columns={columns}
        emptyText={
          error ?? (loading ? 'Loading audit logs...' : 'No audit logs found.')
        }
      />
    </div>
  );
}
