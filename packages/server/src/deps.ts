import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import {
  getDb,
  JobRepository,
  WorkspaceRepository,
  FigmaCacheRepository,
  ModelRouter,
  JobRunner,
  loadModelConfig,
} from "@blocksmith/core";
import { env } from "./env.js";

const MODELS_CONFIG_PATH = resolve(import.meta.dirname, "../../../config/models.json");

const db = getDb(resolve(env.databasePath));
export const jobs = new JobRepository(db);
export const workspaces = new WorkspaceRepository(db);
export const figmaCache = new FigmaCacheRepository(db);

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(100); // one SSE connection per open job detail view, plausible to exceed the default 10

export const router = new ModelRouter({
  apiKey: env.openrouterApiKey,
  models: loadModelConfig(MODELS_CONFIG_PATH),
  appName: "Blocksmith",
});

export const jobRunner = new JobRunner({
  jobs,
  workspaces,
  figmaCache,
  router,
  figmaToken: env.figmaToken,
  scratchDir: resolve(env.scratchDir),
  eventBus,
});
