import { env } from "./env.js";
import { router } from "./deps.js";
import { createApp } from "./app.js";

async function main() {
  // Fails loudly on a typo'd model id in config/models.json before accepting any traffic,
  // rather than surfacing it as a mysterious failure on the first real job.
  await router.validateModels();

  const app = createApp();
  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Blocksmith server listening on http://localhost:${env.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start Blocksmith server:", err);
  process.exit(1);
});
