import { ExternalLink, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AdminConsoleTable } from '../AdminConsoleTable';
import type { Tool } from '../adminConsole.types';

type ToolsTabProps = {
  tools: Tool[];
  loading: boolean;
  currentToolId: string;
  onCreateTool: (tool: { name: string; description: string; url: string }) => Promise<void>;
  onUpdateTool: (id: string, tool: { description: string; url: string }) => Promise<void>;
  onDeleteTool: (id: string) => Promise<void>;
};

export function ToolsTab({ tools, loading, currentToolId, onCreateTool, onUpdateTool, onDeleteTool }: ToolsTabProps) {
  const [showForm, setShowForm] = useState(false);
  const [selectedToolId, setSelectedToolId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTool = tools.find((tool) => tool.id === selectedToolId);

  useEffect(() => {
    if (!selectedTool) return;
    setName(selectedTool.name);
    setDescription(selectedTool.description ?? '');
    setUrl(selectedTool.url);
  }, [selectedTool]);

  const resetForm = () => {
    setSelectedToolId('');
    setName('');
    setDescription('');
    setUrl('');
    setError(null);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (selectedTool) {
        await onUpdateTool(selectedTool.id, { description, url });
      } else {
        await onCreateTool({ name, description, url });
      }
      resetForm();
      setShowForm(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to save tool');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="admin-console__section">
      <AdminConsoleTable
        title="Tool Management"
        actionText="Add Tool"
        onAction={() => {
          resetForm();
          setShowForm(true);
        }}
        addForm={
          showForm ? (
            <form
              className="admin-console-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <h3 className="admin-console-form__title card__title">
                {selectedTool ? 'Edit Tool' : 'Add New Tool'}
              </h3>
              <div className="admin-console-form__grid">
                <div className="admin-console-form__field">
                  <label htmlFor="admin-tool-select">Existing tool</label>
                  <select
                    id="admin-tool-select"
                    value={selectedToolId}
                    onChange={(event) => setSelectedToolId(event.target.value)}
                    disabled={submitting}
                  >
                    <option value="">Create a new tool</option>
                    {tools.map((tool) => (
                      <option key={tool.id} value={tool.id}>
                        {tool.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="admin-console-form__field">
                  <label htmlFor="admin-tool-name">Tool name</label>
                  <input
                    id="admin-tool-name"
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={Boolean(selectedTool) || submitting}
                    required
                  />
                </div>
              </div>
              <div className="admin-console-form__field">
                <label htmlFor="admin-tool-description">Description</label>
                <textarea
                  id="admin-tool-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="admin-console-form__field">
                <label htmlFor="admin-tool-url">URL</label>
                <input
                  id="admin-tool-url"
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  disabled={submitting}
                  required
                />
                <small>URL should start with https://www.</small>
              </div>
              {error && <p role="alert">{error}</p>}
              <div className="admin-console-form__actions">
                <button
                  type="button"
                  className="admin-console__secondary-action"
                  disabled={submitting}
                  onClick={() => {
                    resetForm();
                    setShowForm(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="admin-console-form__button admin-console-form__button--primary"
                  disabled={submitting || !name.trim() || !url.trim()}
                >
                  {submitting
                    ? 'Saving...'
                    : selectedTool
                      ? 'Update Tool'
                      : 'Create Tool'}
                </button>
              </div>
            </form>
          ) : null
        }
        data={tools}
        emptyText={loading ? 'Loading tools...' : 'No tools found.'}
        columns={[
          { key: 'id', label: 'ID' },
          { key: 'name', label: 'Tool Name' },
          { key: 'description', label: 'Description' },
          {
            key: 'created_at',
            label: 'Created At',
            render: (tool) =>
              new Date(tool.created_at).toLocaleString('en-US', {
                month: 'numeric',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                second: '2-digit',
                hour12: true,
              }),
          },
          {
            key: 'actions',
            label: 'Action',
            render: (tool) => (
              <div className="admin-console__action-row">
                {tool.id !== currentToolId && (
                  <a
                    href={tool.url}
                    target="_blank"
                    rel="noreferrer"
                    className="admin-console__secondary-action"
                  >
                    <ExternalLink size={14} /> Open
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => void onDeleteTool(tool.id)}
                  className="admin-console__danger-action"
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
