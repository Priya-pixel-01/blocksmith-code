import { useState } from 'react';

type AddProjectFormProps = {
  onCancel: () => void;
  onCreate: (project: { name: string; toolId: string }) => Promise<void>;
  toolId: string;
};

export function AddProjectForm({ onCancel, onCreate, toolId }: AddProjectFormProps) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), toolId });
      setName('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to create project');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="admin-console-form">
      <h3 className="admin-console-form__title card__title">Add New Project</h3>

      <div className="admin-console-form__field">
        <label htmlFor="admin-project-name">Project Name</label>

        <input
          id="admin-project-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My Project"
        />
      </div>

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
          onClick={() => void submit()}
          className="admin-console-form__button admin-console-form__button--primary"
          disabled={submitting || !name.trim()}
        >
          {submitting ? 'Creating...' : 'Create Project'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
