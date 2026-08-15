import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let harness: Harness;
const closeables: { close(): Promise<void> }[] = [];

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((value) => value.close()));
  await harness.dispose();
});

const connect = async () => {
  const server = createMcpServer(harness.config, createToolRegistry(), harness.services, {
    requestId: 'mcp-test',
    principal: 'key:1',
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closeables.push(client, server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

describe('MCP adapter', () => {
  it('lists the registry tools with routing instructions and annotations', async () => {
    const client = await connect();

    expect(client.getInstructions()).toContain('Data Cruncher');
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['query_json_jq', 'ripgrep_search']);
    for (const tool of tools.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
      expect(tool.inputSchema.properties).toHaveProperty('source');
      expect(tool.outputSchema?.properties).toHaveProperty('warnings');
    }
  });

  it('returns the same structured result as the HTTP transport', async () => {
    await writeFile(join(harness.dataRoot, 'data.json'), JSON.stringify({ status: 'ok' }));
    const client = await connect();

    const mcpResult = await client.callTool({
      name: 'query_json_jq',
      arguments: { source: { kind: 'local_path', path: 'data.json' }, filter: '.status' },
    });
    const httpResult = await harness.app.inject({
      method: 'POST',
      url: '/tools/query_json_jq',
      headers: { 'x-api-key': 'test-api-key-that-is-at-least-32-characters' },
      payload: { source: { kind: 'local_path', path: 'data.json' }, filter: '.status' },
    });

    expect(mcpResult.structuredContent).toEqual(httpResult.json().result);
    expect((mcpResult.structuredContent as { output: string }).output).toBe('"ok"');
  });

  it('accepts the deprecated filePath field', async () => {
    await writeFile(join(harness.dataRoot, 'app.log'), 'ERROR boom\n');
    const client = await connect();

    const result = await client.callTool({
      name: 'ripgrep_search',
      arguments: { filePath: 'app.log', pattern: 'ERROR' },
    });
    expect((result.structuredContent as { matchCount: number }).matchCount).toBe(1);
  });

  it('reports safe typed errors instead of throwing', async () => {
    const client = await connect();

    const missing = await client.callTool({ name: 'query_json_jq', arguments: {} });
    expect(missing.isError).toBe(true);

    const both = await client.callTool({
      name: 'query_json_jq',
      arguments: {
        source: { kind: 'local_path', path: 'a.json' },
        filePath: 'a.json',
        filter: '.',
      },
    });
    expect(both.isError).toBe(true);
    const text = JSON.stringify(both.content);
    expect(text).toContain('bad_request');
    expect(text).not.toContain(harness.dataRoot);
  });
});
