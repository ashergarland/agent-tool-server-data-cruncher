import { writeFile } from 'node:fs/promises';
import { createAgentToolApplication } from '@agent-tool-platform/runtime/capability';
import { createSilentLogger } from '@agent-tool-platform/runtime/logging';
import { capability } from '../src/capability.js';

const application = await createAgentToolApplication(capability, {
  logger: createSilentLogger(),
  env: {
    NODE_ENV: 'development',
    AUTH_MODE: 'disabled',
    PUBLIC_BASE_URL: process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:8080',
  },
});

const document = `${JSON.stringify(application.openApiDocument(), null, 2)}\n`;
const output = process.argv[2];

if (output) await writeFile(output, document, 'utf8');
else process.stdout.write(document);

await application.shutdown();
