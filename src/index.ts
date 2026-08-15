import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from './app.js';

const application = createApplication();
const sweepIntervalMs = 15 * 60 * 1000;

let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  application.logger.info({ signal, event: 'shutdown.start' }, 'draining');
  // Stop accepting work, abort running children, then let in-flight responses finish.
  application.runtime.beginDraining();
  await Promise.race([application.http.close(), delay(application.config.http.shutdownGraceMs)]);
  await application.runtime.close();
  await application.services.assets.close();
  application.logger.info({ signal, event: 'shutdown.complete' }, 'stopped');
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

const sweep = setInterval(() => {
  void application.services.assets
    .sweep()
    .then((removed) => {
      if (removed > 0) {
        application.logger.info({ event: 'asset.sweep', removed }, 'expired assets removed');
      }
    })
    .catch((error: unknown) =>
      application.logger.warn({ err: error, event: 'asset.sweep.failed' }, 'asset sweep failed'),
    );
}, sweepIntervalMs);
sweep.unref();

try {
  await application.runtime.check();
  await application.services.assets.check();
  await application.http.listen({
    host: application.config.http.host,
    port: application.config.http.port,
  });
} catch (error) {
  application.logger.fatal({ err: error }, 'startup failed');
  process.exitCode = 1;
  await application.runtime.close();
}
