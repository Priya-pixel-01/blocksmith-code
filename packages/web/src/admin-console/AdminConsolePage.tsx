import { useEffect, useRef, useState } from 'react';

import { AddMemberForm } from './components/AddMemberForm';
import { AddProjectForm } from './components/AddProjectForm';
import { AddUserForm } from './components/AddUserForm';
import { AdminTabs } from './components/AdminTabs';
import { ProjectMembers } from './components/ProjectMembers';
import { ProjectsTab } from './components/ProjectsTab';
import { UsersTab } from './components/UsersTab';
import { APIKeysTab } from './components/APIKeysTab';
import { AuditLogsTab } from './components/AuditLogsTab';
import { ToolsTab } from './components/ToolsTab';
import type {
  AdminTabKey,
  AuditLog,
  AvailableUser,
  Project,
  ProjectMember,
  Tool,
  User,
} from './adminConsole.types';
import { adminConsoleService } from './adminConsole.service';

const CURRENT_TOOL_ID = 'acbee42e-f97d-411c-813e-8405fee19f73';

export function AdminConsolePage() {
  const [activeTab, setActiveTab] = useState<AdminTabKey>('users');
  const [showUserForm, setShowUserForm] = useState(false);
  const [userFormKey, setUserFormKey] = useState(0);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showMemberForm, setShowMemberForm] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditLogsLoading, setAuditLogsLoading] = useState(false);
  const [auditLogsError, setAuditLogsError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [availableUsers, setAvailableUsers] = useState<AvailableUser[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersLoadedForProjectId, setMembersLoadedForProjectId] = useState<
    string | null
  >(null);
  const loadedTabs = useRef(new Set<AdminTabKey>());

  useEffect(() => {
    if (activeTab !== 'users' || loadedTabs.current.has('users')) return;
    loadedTabs.current.add('users');
    setUsersLoading(true);
    adminConsoleService
      .getUsers()
      .then((data) => setUsers(data))
      .catch((error: unknown) => {
        setUsersError(
          error instanceof Error ? error.message : 'Failed to load users',
        );
      })
      .finally(() => setUsersLoading(false));
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'projects' || loadedTabs.current.has('projects')) return;
    loadedTabs.current.add('projects');
    setProjectsLoading(true);
    adminConsoleService
      .getProjects(CURRENT_TOOL_ID)
      .then(setProjects)
      .catch((error: unknown) => {
        setProjectsError(
          error instanceof Error ? error.message : 'Failed to load projects',
        );
      })
      .finally(() => setProjectsLoading(false));
  }, [activeTab]);

  useEffect(() => {
    if (!selectedProject) return;
    let active = true;
    setMembersLoading(true);
    setMembers([]);
    setAvailableUsers([]);
    setMembersLoadedForProjectId(null);
    Promise.all([
      adminConsoleService.getMembers(selectedProject.id),
      adminConsoleService.getAvailableUsers(selectedProject.id),
    ])
      .then(([projectMembers, users]) => {
        if (active) {
          setMembers(projectMembers);
          setAvailableUsers(users);
          setMembersLoadedForProjectId(selectedProject.id);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setMembersLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedProject]);

  // Admin Console: Users tab - load tool choices for the add-user form.
  useEffect(() => {
    if (
      (activeTab !== 'users' && activeTab !== 'tools') ||
      loadedTabs.current.has('tools')
    )
      return;
    loadedTabs.current.add('tools');
    setToolsLoading(true);
    adminConsoleService
      .getTools()
      .then(setTools)
      .finally(() => setToolsLoading(false));
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'auditLogs') return;

    let active = true;
    setAuditLogsLoading(true);
    setAuditLogsError(null);
    adminConsoleService
      .getAuditLogs()
      .then((data) => {
        if (active) setAuditLogs(data);
      })
      .catch((error: unknown) => {
        if (active) {
          setAuditLogsError(
            error instanceof Error
              ? error.message
              : 'Failed to load audit logs',
          );
        }
      })
      .finally(() => {
        if (active) setAuditLogsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [activeTab]);

  const deleteUser = async (id: string) => {
    await adminConsoleService.deleteUser(id);
    setUsers((current) => current.filter((user) => user.id !== id));
  };

  const deleteMember = async (userId: string) => {
    if (!selectedProject) return;
    const removedMember = members.find((member) => member.user_id === userId);
    await adminConsoleService.deleteMember(selectedProject.id, userId);
    setMembers((current) =>
      current.filter((member) => member.user_id !== userId),
    );
    if (removedMember) {
      setAvailableUsers((current) => [
        ...current.filter((user) => user.id !== userId),
        { id: removedMember.user_id, email: removedMember.user },
      ]);
    }
  };

  const deleteProject = async (id: string) => {
    await adminConsoleService.deleteProject(id);
    setProjects((current) => current.filter((project) => project.id !== id));
  };

  const openProjectMembers = (project: Project) => {
    setMembers([]);
    setAvailableUsers([]);
    setMembersLoadedForProjectId(null);
    setMembersLoading(true);
    setSelectedProject(project);
    setShowMemberForm(false);
  };

  const closeProjectMembers = () => {
    setSelectedProject(null);
    setMembers([]);
    setAvailableUsers([]);
    setMembersLoadedForProjectId(null);
    setMembersLoading(false);
    setShowMemberForm(false);
  };

  const toggleUserForm = () => {
    setShowUserForm((current) => {
      if (!current) setUserFormKey((key) => key + 1);
      return !current;
    });
  };

  return (
    <>
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="page-header">
          <h1>Admin Console</h1>
          <p className="page-header__subtitle">
            Manage Users, Projects, API Keys, Tools, Audit Logs
          </p>
        </div>

        <AdminTabs activeTab={activeTab} onTabChange={setActiveTab} />
        <br />

        {activeTab === 'users' && (
          <UsersTab
            users={users}
            loading={usersLoading}
            error={usersError}
            showAddForm={showUserForm}
            onAddUser={toggleUserForm}
            onDeleteUser={deleteUser}
            addForm={
              <AddUserForm
                key={userFormKey}
                tools={tools}
                toolsLoading={toolsLoading}
                onCancel={() => setShowUserForm(false)}
                onCreate={async (payload) => {
                  await adminConsoleService.createUser(payload);
                  // Refresh the server-sorted users list so the new user appears first.
                  const refreshedUsers = await adminConsoleService.getUsers();
                  setUsers(refreshedUsers);
                }}
              />
            }
          />
        )}

        {activeTab === 'projects' && (
          <div className="space-y-6">
            {projectsLoading && <p>Loading projects...</p>}
            {projectsError && <p role="alert">{projectsError}</p>}
            {selectedProject ? (
              <ProjectMembers
                project={selectedProject}
                members={members}
                showForm={showMemberForm}
                onBack={closeProjectMembers}
                onAddMember={() => setShowMemberForm((value) => !value)}
                onDeleteMember={deleteMember}
                availableUsers={availableUsers}
                usersLoading={membersLoading}
                loading={
                  membersLoading ||
                  membersLoadedForProjectId !== selectedProject.id
                }
                onCreateMember={async (member) => {
                  await adminConsoleService.createMember(
                    selectedProject.id,
                    member,
                  );
                  const [projectMembers, users] = await Promise.all([
                    adminConsoleService.getMembers(selectedProject.id),
                    adminConsoleService.getAvailableUsers(selectedProject.id),
                  ]);
                  setMembers(projectMembers);
                  setAvailableUsers(users);
                  setShowMemberForm(false);
                }}
              />
            ) : (
              <ProjectsTab
                projects={projects}
                members={members}
                showProjectForm={showProjectForm}
                onAddProject={() => setShowProjectForm((value) => !value)}
                onDeleteProject={deleteProject}
                onOpenProjectMembers={openProjectMembers}
                projectForm={
                  <AddProjectForm
                    toolId={CURRENT_TOOL_ID}
                    onCancel={() => setShowProjectForm(false)}
                    onCreate={async (project) => {
                      await adminConsoleService.createProject(project);
                      setProjects(
                        await adminConsoleService.getProjects(CURRENT_TOOL_ID),
                      );
                      setShowProjectForm(false);
                    }}
                  />
                }
              />
            )}
          </div>
        )}

        {activeTab === 'apiKeys' && <APIKeysTab projects={projects} />}

        {activeTab === 'tools' && (
          <ToolsTab
            tools={tools}
            loading={toolsLoading}
            currentToolId={CURRENT_TOOL_ID}
            onCreateTool={async (tool) => {
              await adminConsoleService.createTool(tool);
              setTools(await adminConsoleService.getTools());
            }}
            onUpdateTool={async (id, tool) => {
              await adminConsoleService.updateTool(id, tool);
              setTools(await adminConsoleService.getTools());
            }}
            onDeleteTool={async (id) => {
              await adminConsoleService.deleteTool(id);
              setTools((current) => current.filter((tool) => tool.id !== id));
            }}
          />
        )}

        {activeTab === 'auditLogs' && (
          <AuditLogsTab
            auditLogs={auditLogs}
            loading={auditLogsLoading}
            error={auditLogsError}
          />
        )}
      </div>
    </>
  );
}
