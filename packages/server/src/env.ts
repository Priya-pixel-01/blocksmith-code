import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Walk up src/ → server/ → packages/ → repo root to find .env regardless of cwd
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  isProduction: process.env.NODE_ENV === "production",
  authSessionSecret: process.env.NODE_ENV === "production"
    ? required("AUTH_SESSION_SECRET")
    : process.env.AUTH_SESSION_SECRET ?? "blocksmith-development-session-secret",
  blocksmithToolSlug: process.env.BLOCKSMITH_TOOL_SLUG ?? "blocksmith",
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  openrouterApiKey: required("OPENROUTER_API_KEY"),
  figmaToken: process.env.FIGMA_TOKEN,
  databasePath: process.env.DATABASE_PATH ?? "./.blocksmith/blocksmith.sqlite",
  scratchDir: process.env.SCRATCH_DIR ?? "./.blocksmith/scratch",
  uploadsDir: process.env.UPLOADS_DIR ?? "./.blocksmith/uploads",
  
  adminDatabase: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL !== "false",
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === "true",
  },
};
