import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config/index.js';
import { createServices } from '../services/index.js';
import { createToolRegistry } from '../tools/registry.js';
import { createMcpServer } from './server.js';

// stdio is a single-user local deployment: authentication is meaningless and local paths are the
// point of the transport, so both are set explicitly here rather than inherited from the process.
const config = loadConfig({
  LOCAL_PATHS_ENABLED: 'true',
  ...process.env,
  AUTH_MODE: 'disabled',
  NODE_ENV: 'development',
});
const services = createServices(config);
const server = createMcpServer(config, createToolRegistry(), services, {
  requestId: `stdio-${process.pid}`,
  principal: 'stdio-client',
});

const shutdown = async (): Promise<void> => {
  await server.close();
  await services.runtime.close();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await server.connect(new StdioServerTransport());
