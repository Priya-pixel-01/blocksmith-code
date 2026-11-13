import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  setWorkspace,
  getWorkspace,
  getWorkspaceBatches,
  refreshWorkspace,
  browseWorkspacePath,
  deleteWorkspaceBatch,
  ApiError,
} from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import type { BatchSummary, Workspace } from '../types.js';

const STORAGE_KEY = 'blocksmith:lastWorkspaceId';

function summarizeBatchStatus(byStatus: BatchSummary['byStatus']): string {
  const done = byStatus.done ?? 0;
  const failed = byStatus.failed ?? 0;
  const rejected = byStatus.rejected ?? 0;
  const total = Object.values(byStatus).reduce((sum, n) => sum + (n ?? 0), 0);
  const finished = done + failed + rejected;
  if (finished < total) return `${finished}/${total} finished`;
  if (failed > 0) return `${done}/${total} done, ${failed} failed`;
  return `${done}/${total} done`;
}

function evidenceLabel(signalId: string, path: string): string {
  const labels: Record<string, string> = {
    'aem-maven-dependency': 'Maven project descriptor',
    'aem-package-dependency': 'AEM package dependency',
    'aem-module': `AEM ${path} module`,
  };
  return labels[signalId] ?? path;
}

export function WorkspacePage() {
  const navigate = useNavigate();
  const [rootPath, setRootPath] = useState('');
  const [workspace, setWorkspaceState] = useState<Workspace | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<BatchSummary | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const lastId = localStorage.getItem(STORAGE_KEY);
    if (!lastId) return;
    getWorkspace(lastId)
      .then((ws) => {
        setWorkspaceState(ws);
        setRootPath(ws.rootPath);
      })
      .catch(() => localStorage.removeItem(STORAGE_KEY));
  }, []);

  useEffect(() => {
    if (!workspace) return;
    getWorkspaceBatches(workspace.id)
      .then((res) => setBatches(res.batches))
      .catch(() => setBatches([]));
  }, [workspace]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      let workspaceId: string;
      let profile: Workspace['repoProfile'];

      if (workspace && forceRefresh) {
        // If workspace exists and force refresh is checked, use refresh endpoint
        const result = await refreshWorkspace(workspace.id, true);
        workspaceId = result.workspaceId;
        profile = result.profile;
      } else {
        // Otherwise use setWorkspace (which caches by default)
        const result = await setWorkspace(rootPath);
        workspaceId = result.workspaceId;
        profile = result.profile;
      }

      localStorage.setItem(STORAGE_KEY, workspaceId);
      setWorkspaceState({
        id: workspaceId,
        rootPath,
        isGitRepo: profile?.isGitRepo ?? false,
        repoProfile: profile,
      });
      setForceRefresh(false); // Reset after successful refresh
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not read that folder.',
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleBrowseFolder() {
    setBrowsing(true);
    setError(null);
    try {
      const result = await browseWorkspacePath();
      if (result.rootPath) {
        setRootPath(result.rootPath);
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not open folder browser.',
      );
    } finally {
      setBrowsing(false);
    }
  }

  const profile = workspace?.repoProfile;

  function closeDeleteDialog() {
    setSelectedBatch(null);
    setDialogOpen(false);
    setDeleteError(null);
  }

  async function handleBatchDelete() {
    if (!workspace || !selectedBatch) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await deleteWorkspaceBatch(workspace.id, selectedBatch.batchId);
      setBatches((current) =>
        current.filter((batch) => batch.batchId !== selectedBatch.batchId),
      );
      closeDeleteDialog();
    } catch (err) {
      setDeleteError(
        err instanceof ApiError
          ? err.message
          : 'Could not delete that batch.',
      );
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div className="page-header__eyebrow">Step 1</div>
        <h1>Point Blocksmith at a repo</h1>
        <p className="page-header__subtitle">
          Give it the local path to an Adobe Edge Delivery Services project. It
          reads the codebase once — existing blocks, design tokens, breakpoints,
          and Universal Editor wiring — before it touches anything.
        </p>
      </div>

      <div className="card">
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="rootPath">Repository folder path</label>
            <div
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                alignItems: 'center',
              }}
            >
              <input
                id="rootPath"
                type="text"
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder="/Users/you/projects/my-eds-site"
                required
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn--secondary"
                onClick={handleBrowseFolder}
                disabled={loading || browsing}
              >
                {browsing ? 'Opening...' : 'Browse...'}
              </button>
              {workspace && (
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    localStorage.removeItem(STORAGE_KEY);
                    setWorkspaceState(null);
                    setRootPath('');
                  }}
                >
                  Delete
                </button>
              )}
            </div>
            <span className="field__hint">
              An absolute path on this machine. Re-pointing at the same folder
              reuses its cached profile.
            </span>
          </div>
          <div className="btn-row">
            {workspace && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={forceRefresh}
                  onChange={(e) => setForceRefresh(e.target.checked)}
                />
                <span>Force fresh scan (ignore cache)</span>
              </label>
            )}
            <button
              type="submit"
              className="btn btn--primary"
              disabled={loading || !rootPath}
            >
              {loading ? <span className="spinner" /> : null}
              {workspace
                ? forceRefresh
                  ? 'Force refresh'
                  : 'Reload profile'
                : 'Read repository'}
            </button>
            {workspace && (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => navigate(`/workspace/${workspace.id}/new-batch`)}
              >
                Continue →
              </button>
            )}
          </div>
        </form>
        {error && (
          <div
            className="callout callout--danger"
            style={{ marginTop: 'var(--space-4)' }}
          >
            {error}
          </div>
        )}
      </div>

      {profile && (
        <div className="card">
          <h2 className="card__title">Repo profile</h2>
          <dl className="kv-list">
            <dt>Project type</dt>
            <dd>
              <strong>{profile.projectType.toUpperCase()}</strong> (
              {profile.classification.confidenceBand} confidence
              {/* {profile.projectType === 'aem' &&
                `AEM score: ${profile.classification.aemScore}`}
              {profile.projectType === 'eds' &&
                `EDS score: ${profile.classification.edsScore}`}
              {profile.projectType === 'mixed' &&
                `AEM score: ${profile.classification.aemScore}, EDS score: ${profile.classification.edsScore}`}
              {profile.projectType === 'unknown' &&
                'no architecture score reached the detection threshold'} */}
              )
            </dd>
            {(profile.projectType === 'aem' ||
              profile.projectType === 'mixed') && (
              <>
                <dt>Detection evidence</dt>
                <dd>
                  <div className="tag-list">
                    {profile.classification.evidence
                      .filter(
                        (item) =>
                          item.polarity === 'positive' &&
                          (item.signalId.startsWith('aem-') ||
                            profile.projectType === 'mixed'),
                      )
                      .map((item) => (
                        <span
                          className="tag"
                          key={`${item.signalId}-${item.path}`}
                        >
                          {evidenceLabel(item.signalId, item.path)}
                        </span>
                      ))}
                  </div>
                </dd>
                <dt>AEM components</dt>
                <dd>{profile.aemComponents.length}</dd>
                <dt>AEM modules</dt>
                <dd>
                  {profile.modules.length > 0
                    ? profile.modules.map((module) => module.id).join(', ')
                    : 'none detected'}
                </dd>
              </>
            )}
            {profile.projectType === 'eds' && (
              <>
                <dt>Universal Editor</dt>
                <dd>
                  {profile.authoringSurface.hasUniversalEditor
                    ? `Yes — ${profile.authoringSurface.modelShape} model shape`
                    : 'No — document authoring only'}
                </dd>
              </>
            )}
            <dt>Git repository</dt>
            <dd>
              {profile.isGitRepo
                ? 'Yes'
                : 'No — writes will be direct with a backup'}
            </dd>
            <dt>Lint</dt>
            <dd>
              {profile.conventions.jsLinter ?? 'not detected'}
              {profile.conventions.lintCommand
                ? ` (npm run ${profile.conventions.lintCommand})`
                : ''}
            </dd>
            <dt>Breakpoints</dt>
            <dd>
              <div className="tag-list">
                {profile.tokens.breakpoints.length === 0 && (
                  <span className="tag">none detected</span>
                )}
                {profile.tokens.breakpoints.map((b) => (
                  <span className="tag" key={b.mediaQuery}>
                    {b.mediaQuery}
                  </span>
                ))}
              </div>
            </dd>
            {profile.projectType === 'eds' && (
              <>
                <dt>Blocks ({profile.blocks.length})</dt>
                <dd>
                  <div className="tag-list">
                    {profile.blocks.map((b) => (
                      <span
                        className="tag"
                        key={b.name}
                        title={b.purpose || undefined}
                      >
                        {b.name}
                        {b.hasUeJson ? ' ·UE' : ''}
                      </span>
                    ))}
                  </div>
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      {workspace && batches.length > 0 && (
        <div className="card">
          <h2 className="card__title">Recent batches</h2>
          <div className="card-list">
            {batches.map((b) => (
              <div className="batch-row" key={b.batchId}>
                <Link
                  to={`/batch/${b.batchId}`}
                  className="plain-link batch-row__link"
                >
                  <div className="job-row__main">
                    <div className="job-row__title">{b.batchTitle}</div>
                    <div className="job-row__subtitle">
                      {b.jobCount} source{b.jobCount === 1 ? '' : 's'}
                    </div>
                    <div className="job-row__meta">
                      {new Date(b.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <span className="tag">
                    {summarizeBatchStatus(b.byStatus)}
                  </span>
                </Link>
                <button
                  type="button"
                  className="batch-row__delete"
                  title="Delete batch"
                  aria-label={`Delete batch created ${new Date(b.createdAt).toLocaleString()}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    setSelectedBatch(b);
                    setDialogOpen(true);
                    setDeleteError(null);
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 7h16" />
                    <path d="M10 11v6" />
                    <path d="M14 11v6" />
                    <path d="M5 7l1 13h12l1-13" />
                    <path d="M9 7V4h6v3" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {selectedBatch && dialogOpen && (
        <ConfirmDialog
          title="Delete batch?"
          message={`Delete "${selectedBatch.batchTitle}"? This action cannot be undone.`}
          confirmLabel="Delete"
          pending={deletePending}
          error={deleteError}
          onConfirm={handleBatchDelete}
          onCancel={closeDeleteDialog}
        />
      )}
    </>
  );
}
