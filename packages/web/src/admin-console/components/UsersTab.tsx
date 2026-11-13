import { Trash2 } from 'lucide-react';

import { AdminConsoleTable } from '../AdminConsoleTable';
import type { User } from '../adminConsole.types';

type UsersTabProps = {
  users: User[];
  loading?: boolean;
  error?: string | null;
  onAddUser: () => void;
  onDeleteUser: (id: string) => void;
  showAddForm: boolean;
  addForm: React.ReactNode;
};

export function UsersTab({
  users,
  loading = false,
  error = null,
  onAddUser,
  onDeleteUser,
  showAddForm,
  addForm,
}: UsersTabProps) {
  if (loading || error) {
    return (
      <div className="admin-console__section">
        <AdminConsoleTable
          title="User Management"
          actionText="Add User"
          onAction={onAddUser}
          columns={[]}
          data={[]}
          emptyText={error ?? 'Loading users...'}
        />
      </div>
    );
  }

  return (
    <div className="admin-console__section">
      <AdminConsoleTable
        title="User Management"
        actionText="Add User"
        onAction={onAddUser}
        addForm={showAddForm ? addForm : null}
        data={users}
        columns={[
          { key: 'id', label: 'ID' },
          { key: 'email', label: 'Email' },
          {
            key: 'admin',
            label: 'Admin',
            render: (user) =>
              user.admin ? (
                <span className="admin-console__status admin-console__status--yes">
                  Yes
                </span>
              ) : (
                <span className="admin-console__status admin-console__status--no">
                  No
                </span>
              ),
          },
          { key: 'created', label: 'Created' },
          { key: 'updated_at', label: 'Updated' },
          {
            key: 'actions',
            label: 'Action',
            render: (user) => (
              <button
                type="button"
                onClick={() => onDeleteUser(user.id)}
                className="admin-console__danger-action"
              >
                <Trash2 size={14} />
                Delete
              </button>
            ),
          },
        ]}
      />
    </div>
  );
}
