import { useState } from 'react';
import type { Tool } from '../adminConsole.types';

type AddUserFormProps = {
  onCancel: () => void;
  onCreate: (user: {
    email: string;
    password: string;
    isAdmin: boolean;
    toolIds: string[];
  }) => Promise<void>;
  tools: Tool[];
  toolsLoading: boolean;
};

function formatToolName(name: string): string {
  const normalizedName = name.trim().toLowerCase();
  return normalizedName.charAt(0).toUpperCase() + normalizedName.slice(1);
}

export function AddUserForm({
  onCancel,
  onCreate,
  tools,
  toolsLoading,
}: AddUserFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [admin, setAdmin] = useState(false);
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleTool = (toolId: string) => {
    setSelectedToolIds((current) =>
      current.includes(toolId)
        ? current.filter((item) => item !== toolId)
        : [...current, toolId],
    );
  };

  const resetForm = () => {
    setEmail('');
    setPassword('');
    setAdmin(false);
    setSelectedToolIds([]);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        email,
        password,
        isAdmin: admin,
        toolIds: selectedToolIds,
      });

      resetForm();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Failed to create user',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="admin-console-form"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="admin-console-form__title card__title">Add New User</h3>

      <div className="admin-console-form__grid">
        <div className="admin-console-form__field">
          <label htmlFor="admin-user-email">Email</label>
          <input
            id="admin-user-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="user@deloitte.com"
          />
        </div>

        <div className="admin-console-form__field">
          <label htmlFor="admin-user-password">Password</label>
          <input
            id="admin-user-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter a password"
          />
        </div>
      </div>

      <label className="admin-console-form__checkbox">
        <input
          type="checkbox"
          checked={admin}
          onChange={(event) => setAdmin(event.target.checked)}
        />
        Make this user an admin
      </label>

      <div
        className="admin-console-form__field"
        style={{ marginTop: 'var(--space-4)', gap: 'var(--space-1)' }}
      >
        <label>Tools</label>

        <div className="admin-console-form__tool-picker">
          {toolsLoading ? (
            <span>Loading tools...</span>
          ) : (
            tools.map((tool) => (
              <button
                key={tool.id}
                type="button"
                onClick={() => toggleTool(tool.id)}
                className={`admin-console-form__tool ${
                  selectedToolIds.includes(tool.id)
                    ? 'admin-console-form__tool--active'
                    : ''
                }`}
              >
                {formatToolName(tool.name)}
              </button>
            ))
          )}
        </div>
      </div>

      {error && <p role="alert">{error}</p>}

      <div className="admin-console-form__actions">
        <button
          type="button"
          onClick={onCancel}
          className="admin-console__secondary-action"
          disabled={submitting}
        >
          Cancel
        </button>

        <button
          type="button"
          onClick={submit}
          className="admin-console-form__button admin-console-form__button--primary"
          disabled={submitting || toolsLoading}
        >
          {submitting ? 'Creating...' : 'Create User'}
        </button>
      </div>
    </form>
  );
}
