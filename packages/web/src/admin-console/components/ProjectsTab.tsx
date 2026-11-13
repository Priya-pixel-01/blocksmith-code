import { Trash2 } from 'lucide-react';

import { AdminConsoleTable } from '../AdminConsoleTable';
import type { Project, ProjectMember } from '../adminConsole.types';

type ProjectsTabProps = {
  projects: Project[];
  members: ProjectMember[];
  showProjectForm: boolean;
  projectForm: React.ReactNode;
  onAddProject: () => void;
  onOpenProjectMembers: (project: Project) => void;
  onDeleteProject: (id: string) => void;
};

export function ProjectsTab({
  projects,
  members,
  showProjectForm,
  projectForm,
  onAddProject,
  onOpenProjectMembers,
  onDeleteProject,
}: ProjectsTabProps) {
  return (
    <div className="admin-console__section">

      <AdminConsoleTable
        title="Project Management"
        actionText="Add Project"
        onAction={onAddProject}
        addForm={showProjectForm ? projectForm : null}
        data={projects}
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'created', label: 'Created' },
          { key: 'id', label: 'ID' },
          {
            key: 'actions',
            label: 'Action',
            render: (project) => (
              <div className="admin-console__action-row">
                <button
                  type="button"
                  onClick={() => onOpenProjectMembers(project)}
                  className="admin-console__secondary-action"
                >
                  Manage Members
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteProject(project.id)}
                  className="admin-console__danger-action"
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
            ),
          },
        ]}
      />

      {members.length > 0 && (
        <div className="admin-console__summary">
          <span>
            {members.length} members across {projects.length} project
            {projects.length === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </div>
  );
}
