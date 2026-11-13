import { Trash2 } from 'lucide-react';

import { AdminConsoleTable } from '../AdminConsoleTable';
import type { AvailableUser, Project, ProjectMember } from '../adminConsole.types';
import { AddMemberForm } from './AddMemberForm';

type ProjectMembersProps = {
  project: Project;
  members: ProjectMember[];
  showForm: boolean;
  onBack: () => void;
  onAddMember: () => void;
  onDeleteMember: (userId: string) => Promise<void>;
  onCreateMember: (member: { userId: string; role: string }) => Promise<void>;
  availableUsers: AvailableUser[];
  usersLoading: boolean;
  loading: boolean;
};

export function ProjectMembers({
  project,
  members,
  showForm,
  onBack,
  onAddMember,
  onDeleteMember,
  onCreateMember,
  availableUsers,
  usersLoading,
  loading,
}: ProjectMembersProps) {
  return (
    <div className="space-y-4">
      {loading ? (
        <div className="admin-console__section" role="status" aria-live="polite">
          <div className="card">
            <h2>Members — {project.name}</h2>
            <p>Loading members...</p>
          </div>
        </div>
      ) : (
        <AdminConsoleTable
          title={`Members — ${project.name}`}
          actionText="Add User"
          onAction={onAddMember}
          addForm={
            showForm ? (
              <AddMemberForm
                onCancel={onAddMember}
                onCreate={onCreateMember}
                users={availableUsers}
                usersLoading={usersLoading}
              />
            ) : null
          }
          data={members}
          columns={[
            { key: 'user', label: 'User' },
            { key: 'role', label: 'Role' },
            { key: 'added', label: 'Added' },
            {
              key: 'actions',
              label: 'Action',
              render: (member) => (
                <button
                  type="button"
                  onClick={() => void onDeleteMember(member.user_id)}
                  className="admin-console__danger-action"
                >
                  <Trash2 size={14} />
                  Remove
                </button>
              ),
            },
          ]}
        />
      )}

      <br />
      <button
        type="button"
        onClick={onBack}
        className="admin-console__secondary-action"
        style={{
          color: 'var(--color-accent)',
          borderColor: 'var(--color-accent)',
        }}
      >
        ← Back to Projects
      </button>
    </div>
  );
}
