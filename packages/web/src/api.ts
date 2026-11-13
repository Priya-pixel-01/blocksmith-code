import type { BatchSummary, Job, Workspace } from "./types.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface CurrentUser {
  id: string;
  email: string;
  isAdmin: boolean;
  tools: string[];
}

export type Tool = {
  id: string;
  name: string;
  description: string | null;
  url: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body);
  }
  return res.json() as Promise<T>;
}

export function getCurrentUser(): Promise<{ user: CurrentUser }> {
  return request("/auth/me");
}

export function login(email: string, password: string): Promise<{ user: CurrentUser }> {
  return request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export function logout(): Promise<{ ok: true }> {
  return request("/auth/logout", { method: "POST" });
}

export function getTools(): Promise<Tool[]> {
  return request("/tools");
}

let toolsRequest: Promise<Tool[]> | null = null;

export function getCachedTools(): Promise<Tool[]> {
  if (!toolsRequest) {
    toolsRequest = getTools().catch((error: unknown) => {
      toolsRequest = null;
      throw error;
    });
  }
  return toolsRequest;
}

export function clearCachedTools(): void {
  toolsRequest = null;
}

export function setWorkspace(rootPath: string): Promise<{ workspaceId: string; profile: Workspace["repoProfile"] }> {
  return request("/workspace", { method: "POST", body: JSON.stringify({ rootPath }) });
}

export function browseWorkspacePath(): Promise<{ rootPath: string | null }> {
  return request("/workspace/browse", { method: "POST" });
}

export function getWorkspace(id: string): Promise<Workspace> {
  return request(`/workspace/${id}/profile`);
}

export function refreshWorkspace(id: string, force?: boolean): Promise<{ workspaceId: string; profile: Workspace["repoProfile"] }> {
  return request(`/workspace/${id}/refresh`, { method: "POST", body: JSON.stringify({ force: force ?? false }) });
}

export function getWorkspaceBatches(id: string): Promise<{ batches: BatchSummary[] }> {
  return request(`/workspace/${id}/batches`);
}

export function deleteWorkspaceBatch(workspaceId: string, batchId: string): Promise<{ ok: true }> {
  return request(`/workspace/${workspaceId}/batches/${batchId}`, { method: "DELETE" });
}

export function terminateJob(id: string): Promise<{ ok: true }> {
  return request(`/jobs/${id}/terminate`, { method: "POST" });
}

export async function uploadFile(file: File): Promise<{ path: string; kind: "image" | "pdf"; originalName: string }> {
  const form = new FormData();
  form.append("file", file);
  return request("/uploads", { method: "POST", body: form });
}

export type BatchSource = { kind: "figma"; ref: string } | { kind: "image"; ref: string } | { kind: "pdf"; ref: string };

export function createBatch(workspaceId: string, sources: BatchSource[], forceRefresh?: boolean, implementationMode?: "properties" | "sling_model"): Promise<{ batchId: string; jobIds: string[] }> {
  return request("/batch", { method: "POST", body: JSON.stringify({ workspaceId, sources, forceRefresh: forceRefresh ?? false, implementationMode }) });
}

export function previewFigma(url: string): Promise<{ cached: boolean; previewImage?: string; updatedAt?: string }> {
  return request("/figma/preview", { method: "POST", body: JSON.stringify({ url }) });
}

export function listJobs(batchId: string): Promise<{ jobs: Job[] }> {
  return request(`/jobs?batchId=${encodeURIComponent(batchId)}`);
}

export function getJob(id: string): Promise<Job> {
  return request(`/jobs/${id}`);
}

export function submitAnswers(id: string, answers: Array<{ questionId: string; value: string }>, feedback?: string): Promise<{ ok: true }> {
  return request(`/jobs/${id}/answers`, { method: "POST", body: JSON.stringify({ answers, feedback }) });
}

export function approveJob(id: string): Promise<{ ok: true }> {
  return request(`/jobs/${id}/approve`, { method: "POST" });
}

export function approveJobCodeOnly(id: string): Promise<{ ok: true }> {
  return request(`/jobs/${id}/approve-code-only`, { method: "POST" });
}

export function rejectJob(id: string, feedback: string): Promise<{ ok: true }> {
  return request(`/jobs/${id}/reject`, { method: "POST", body: JSON.stringify({ feedback }) });
}

export function retryJob(id: string): Promise<{ ok: true; jobId: string; batchId: string }> {
  return request(`/jobs/${id}/retry`, { method: "POST" });
}

export function deleteJob(id: string): Promise<{ ok: true }> {
  return request(`/jobs/${id}`, { method: "DELETE" });
}

export function submitPostFeedback(id: string, feedback: string): Promise<{ ok: true }> {
  return request(`/jobs/${id}/post-feedback`, { method: "POST", body: JSON.stringify({ feedback }) });
}

export function subscribeToJobEvents(jobId: string, onEvent: (event: import("./types.js").JobEvent) => void): () => void {
  const source = new EventSource(`/api/jobs/${jobId}/events`);
  const terminalStatuses = new Set(["done", "failed", "rejected", "code_only"]);
  source.onmessage = (e) => {
    const event = JSON.parse(e.data) as import("./types.js").JobEvent;
    onEvent(event);
    if (event.type === "status" && typeof event.data === "object" && event.data !== null && terminalStatuses.has((event.data as { status?: string }).status ?? "")) {
      source.close();
    }
  };
  return () => source.close();
}
