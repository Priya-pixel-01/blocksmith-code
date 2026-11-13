import { useState } from 'react';
import type { AvailableUser } from '../adminConsole.types';

type AddMemberFormProps = {
  onCancel: () => void;
  onCreate: (member: { userId: string; role: string }) => Promise<void>;
  users: AvailableUser[];
  usersLoading: boolean;
};

export function AddMemberForm({ onCancel, onCreate, users, usersLoading }: AddMemberFormProps) {
  const [user, setUser] = useState('');
  const [role, setRole] = useState('Member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!user) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ userId: user, role });
      setUser('');
      setRole('Member');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to add member');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="admin-console-form">
      <h3 className="admin-console-form__title card__title">
        Add Project Member
      </h3>

      <div className="admin-console-form__grid">
        <div className="admin-console-form__field">
          <label htmlFor="admin-member-user">User</label>

          <select
            id="admin-member-user"
            value={user}
            onChange={(event) => setUser(event.target.value)}
          >
            <option value="">{usersLoading ? 'Loading users...' : 'Select user'}</option>
            {users.map((availableUser) => (
              <option key={availableUser.id} value={availableUser.id}>{availableUser.email}</option>
            ))}
          </select>
        </div>

        <div className="admin-console-form__field">
          <label htmlFor="admin-member-role">Role</label>

          <select
            id="admin-member-role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            <option value="Member">Member</option>
            <option value="Admin">Admin</option>
            <option value="Viewer">Viewer</option>
          </select>
        </div>
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
          disabled={submitting || usersLoading || !user}
        >
          Add User
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
