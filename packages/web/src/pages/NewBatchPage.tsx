import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { uploadFile, createBatch, previewFigma, getWorkspace, ApiError } from "../api.js";
import type { Workspace } from "../types.js";

type SourceKind = "figma" | "image" | "pdf";

interface SourceEntry {
  id: string;
  kind: SourceKind;
  figmaUrl: string;
  file: File | null;
  previewImage?: string;
  cached?: boolean;
  updatedAt?: string;
}

let nextId = 0;
function newEntry(kind: SourceKind): SourceEntry {
  nextId += 1;
  return { id: `s${nextId}`, kind, figmaUrl: "", file: null };
}

export function NewBatchPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const [sources, setSources] = useState<SourceEntry[]>([newEntry("figma")]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [implementationMode, setImplementationMode] = useState<"properties" | "sling_model" | "">("");
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    getWorkspace(workspaceId)
      .then(setWorkspace)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Could not load workspace profile."))
      .finally(() => setWorkspaceLoading(false));
  }, [workspaceId]);

  const requiresImplementationMode = ["aem", "mixed"].includes(workspace?.repoProfile?.projectType ?? "");

  function updateSource(id: string, patch: Partial<SourceEntry>) {
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function removeSource(id: string) {
    setSources((prev) => prev.filter((s) => s.id !== id));
  }

  async function handleFigmaUrlChange(id: string, url: string) {
    updateSource(id, { figmaUrl: url, previewImage: undefined, cached: undefined });
    
    if (url.trim().length > 0 && url.includes("figma.com")) {
      try {
        const preview = await previewFigma(url);
        updateSource(id, { 
          previewImage: preview.previewImage, 
          cached: preview.cached,
          updatedAt: preview.updatedAt,
        });
      } catch (err) {
        // Silent fail - user can still submit
        console.error("Failed to load Figma preview:", err);
      }
    }
  }

  const canSubmit = !workspaceLoading && sources.length > 0 && sources.every((s) => (s.kind === "figma" ? s.figmaUrl.trim().length > 0 : s.file !== null)) && (!requiresImplementationMode || implementationMode !== "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId) return;
    setSubmitting(true);
    setError(null);
    try {
      const resolved = await Promise.all(
        sources.map(async (s) => {
          if (s.kind === "figma") return { kind: "figma" as const, ref: s.figmaUrl.trim() };
          const uploaded = await uploadFile(s.file!);
          return { kind: uploaded.kind, ref: uploaded.path };
        }),
      );
      const { batchId } = await createBatch(workspaceId, resolved, forceRefresh, implementationMode || undefined);
      navigate(`/batch/${batchId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start this batch.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div className="page-header__eyebrow">Step 2</div>
        <h1>Add design sources</h1>
        <p className="page-header__subtitle">
          Submit one or more Figma frames, screenshots, or BRD PDFs. Each becomes its own job and they run in
          parallel — you'll review a plan for each before anything is written.
        </p>
      </div>

      <div className="card">
        <form onSubmit={handleSubmit}>
          {requiresImplementationMode && (
            <fieldset className="field" style={{ marginBottom: "var(--space-5)" }}>
              <legend>Implementation approach</legend>
              <label className="radio-option">
                <input type="radio" name="implementationMode" value="properties" checked={implementationMode === "properties"} onChange={() => setImplementationMode("properties")} />
                <span><strong>Properties-based</strong><span className="text-muted">Use authored component properties and HTL only.</span></span>
              </label>
              <label className="radio-option">
                <input type="radio" name="implementationMode" value="sling_model" checked={implementationMode === "sling_model"} onChange={() => setImplementationMode("sling_model")} />
                <span><strong>Sling Model</strong><span className="text-muted">Allow Java model logic in the core module when requirements need it.</span></span>
              </label>
            </fieldset>
          )}
          <div className="card-list" style={{ marginBottom: "var(--space-4)" }}>
            {sources.map((source) => (
              <div className="source-row" key={source.id}>
                <select
                  className="source-row__type"
                  value={source.kind}
                  onChange={(e) => updateSource(source.id, { kind: e.target.value as SourceKind, file: null, figmaUrl: "" })}
                  style={{ width: "100px", flexShrink: 0 }}
                >
                  <option value="figma">Figma</option>
                  <option value="image">Image</option>
                  <option value="pdf">PDF</option>
                </select>

                {source.kind === "figma" ? (
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                    <input
                      type="url"
                      placeholder="https://www.figma.com/design/…?node-id=…"
                      value={source.figmaUrl}
                      onChange={(e) => handleFigmaUrlChange(source.id, e.target.value)}
                      style={{ width: "100%" }}
                    />
                    {source.previewImage && (
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                        <img 
                          src={source.previewImage} 
                          alt="Figma frame preview" 
                          style={{ maxWidth: "200px", maxHeight: "150px", border: "1px solid var(--gray-3)", borderRadius: "4px" }}
                        />
                        {source.cached && (
                          <span style={{ fontSize: "0.85em", color: "var(--gray-6)" }}>
                            Cached {source.updatedAt ? `(${new Date(source.updatedAt).toLocaleDateString()})` : ""}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <input
                    type="file"
                    accept={source.kind === "pdf" ? "application/pdf" : "image/png,image/jpeg,image/webp,image/gif"}
                    onChange={(e) => updateSource(source.id, { file: e.target.files?.[0] ?? null })}
                    style={{ flex: 1 }}
                  />
                )}

                <button type="button" className="btn btn--secondary btn--sm" onClick={() => removeSource(source.id)} disabled={sources.length === 1}>
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="btn-row">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setSources((prev) => [...prev, newEntry("figma")])}>
              + Add another source
            </button>
          </div>

          <div className="btn-row" style={{ marginTop: "var(--space-5)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flex: 1 }}>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={forceRefresh}
                  onChange={(e) => setForceRefresh(e.target.checked)}
                />
                <span>Force fresh import (ignore cache)</span>
              </label>
            </div>
            <button type="submit" className="btn btn--primary" disabled={!canSubmit || submitting}>
              {submitting ? <span className="spinner" /> : null}
              Start {sources.length > 1 ? `${sources.length} jobs` : "job"}
            </button>
          </div>

          {error && (
            <div className="callout callout--danger" style={{ marginTop: "var(--space-4)" }}>
              {error}
            </div>
          )}
        </form>
      </div>
    </>
  );
}
