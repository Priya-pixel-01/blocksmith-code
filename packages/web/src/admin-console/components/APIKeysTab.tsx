import { useEffect, useState } from 'react';
import { Eye, EyeOff, CheckCircle } from 'lucide-react';
import type { ApiKeyStatus, Project } from '../adminConsole.types';
import { adminConsoleService } from '../adminConsole.service';
import { AdminConsoleTable } from '../AdminConsoleTable';

type APIKeysTabProps = {
  projects: Project[];
};

export function APIKeysTab({ projects }: APIKeysTabProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Fetch API key status when project changes
  useEffect(() => {
    if (!selectedProjectId) return;

    const controller = new AbortController();
    setLoading(true);
    setApiKeyInput('');
    setShowKey(false);

    adminConsoleService
      .getApiKeyStatus(selectedProjectId, controller.signal)
      .then((data) => {
        setApiKeyStatus(data);
        setMessage(null);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('Failed to fetch API key status:', err);
        setMessage({
          type: 'error',
          text: 'Failed to fetch API key status. Please try again.',
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [selectedProjectId]);

  const handleUpdateApiKey = async () => {
    if (!selectedProjectId || !apiKeyInput.trim()) {
      setMessage({ type: 'error', text: 'Please enter a valid API key.' });
      return;
    }

    setSaving(true);
    try {
      const result = await adminConsoleService.updateApiKey(
        selectedProjectId,
        apiKeyInput,
      );
      setApiKeyStatus(result);
      setApiKeyInput('');
      setShowKey(false);
      setMessage({
        type: 'success',
        text: 'API key updated successfully.',
      });
    } catch (err) {
      console.error('Error updating API key:', err);
      setMessage({
        type: 'error',
        text: 'Failed to update API key. Please try again.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-console__section">
      <AdminConsoleTable
        title="Project API Keys"
        actionText=""
        data={projects}
        columns={[
          { key: 'name', label: 'Project' },
          { key: 'created', label: 'Created' },
          { key: 'id', label: 'ID' },
          {
            key: 'actions',
            label: 'Action',
            render: (project) => (
              <button
                type="button"
                className="admin-console__secondary-action"
                onClick={() => setSelectedProjectId(project.id)}
              >
                {selectedProjectId === project.id ? 'Selected' : 'Manage Key'}
              </button>
            ),
          },
        ]}
        emptyText="No projects found."
      />
      <div className="admin-console-form">
        <h3 className="admin-console-form__title">API Keys</h3>
        <p
          style={{
            marginBottom: 'var(--space-5)',
            color: 'var(--color-text-muted)',
          }}
        >
          Manage API keys for your projects
        </p>

        {/* Project Selector */}
        <div
          className="admin-console-form__field"
          style={{ marginBottom: 'var(--space-5)' }}
        >
          <label htmlFor="api-key-project">Select Project</label>
          <select
            id="api-key-project"
            value={selectedProjectId || ''}
            onChange={(e) => setSelectedProjectId(e.target.value || null)}
          >
            <option value="">-- Select a project --</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        {selectedProjectId && (
          <>
            {/* Status Message */}
            {loading ? (
              <div
                className="admin-console__summary"
                style={{
                  marginBottom: 'var(--space-5)',
                  backgroundColor: 'var(--color-idle-soft)',
                }}
              >
                Loading...
              </div>
            ) : apiKeyStatus?.isConfigured ? (
              <div
                style={{
                  padding: 'var(--space-4)',
                  backgroundColor: 'var(--color-success-soft)',
                  borderLeft: '4px solid var(--color-success)',
                  borderRadius: 'var(--radius-md)',
                  marginBottom: 'var(--space-5)',
                  display: 'flex',
                  gap: 'var(--space-3)',
                }}
              >
                <CheckCircle
                  size={20}
                  color="var(--color-success)"
                  style={{ flexShrink: 0 }}
                />
                <div>
                  <strong style={{ color: 'var(--color-success)' }}>
                    ✓ Key is configured for this project
                  </strong>
                  <br />
                  <small style={{ color: 'var(--color-success)' }}>
                    Last updated on{' '}
                    {apiKeyStatus.lastUpdated
                      ? new Date(apiKeyStatus.lastUpdated).toLocaleDateString()
                      : 'unknown'}
                  </small>
                </div>
              </div>
            ) : (
              <div
                style={{
                  padding: 'var(--space-4)',
                  backgroundColor: 'var(--color-warning-soft)',
                  borderLeft: '4px solid var(--color-warning)',
                  borderRadius: 'var(--radius-md)',
                  marginBottom: 'var(--space-5)',
                }}
              >
                <strong style={{ color: 'var(--color-warning)' }}>
                  No API key configured for this project
                </strong>
              </div>
            )}

            {/* API Key Input */}
            <div
              className="admin-console-form__field"
              style={{ marginBottom: 'var(--space-5)' }}
            >
              <label htmlFor="api-key-input">API Key</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="api-key-input"
                  type={showKey ? 'text' : 'password'}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={
                    apiKeyStatus?.isConfigured
                      ? 'Enter new API key to update'
                      : 'Enter your OpenRouter API key'
                  }
                  style={{ paddingRight: 'var(--space-10)' }}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  style={{
                    position: 'absolute',
                    right: 'var(--space-3)',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 'var(--space-2)',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  title={showKey ? 'Hide key' : 'Show key'}
                >
                  {showKey ? (
                    <EyeOff size={18} color="var(--color-text-muted)" />
                  ) : (
                    <Eye size={18} color="var(--color-text-muted)" />
                  )}
                </button>
              </div>
            </div>

            {/* Status Messages */}
            {message && (
              <div
                style={{
                  padding: 'var(--space-3)',
                  marginBottom: 'var(--space-4)',
                  backgroundColor:
                    message.type === 'success'
                      ? 'var(--color-success-soft)'
                      : 'var(--color-danger-soft)',
                  borderLeft: `4px solid ${
                    message.type === 'success'
                      ? 'var(--color-success)'
                      : 'var(--color-danger)'
                  }`,
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <small
                  style={{
                    color:
                      message.type === 'success'
                        ? 'var(--color-success)'
                        : 'var(--color-danger)',
                  }}
                >
                  {message.text}
                </small>
              </div>
            )}

            {/* Update Button */}
            <div className="admin-console-form__actions">
              <button
                type="button"
                onClick={handleUpdateApiKey}
                disabled={saving || !apiKeyInput.trim()}
                className="admin-console-form__button admin-console-form__button--primary"
              >
                {saving ? 'Updating...' : 'Update API Key'}
              </button>
            </div>
          </>
        )}

        {!selectedProjectId && (
          <div
            className="admin-console__summary"
            style={{ textAlign: 'center' }}
          >
            <small>Please select a project to manage its API key</small>
          </div>
        )}
      </div>
    </div>
  );
}
