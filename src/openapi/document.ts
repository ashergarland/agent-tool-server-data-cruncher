import type { AppConfig } from '../config/index.js';
import { serverPurpose } from '../tools/guidance.js';
import type { RegisteredTool, ToolRegistry } from '../tools/registry.js';

type JsonObject = Record<string, unknown>;

const errorSchema: JsonObject = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
        retryable: { type: 'boolean' },
        requestId: { type: 'string' },
      },
    },
  },
};

const errorResponses: JsonObject = Object.fromEntries(
  [
    [400, 'Invalid input'],
    [401, 'Missing or invalid credentials'],
    [403, 'Operation not permitted'],
    [404, 'Unknown tool or resource'],
    [413, 'Input or output exceeded a configured limit'],
    [429, 'Rate limited'],
    [500, 'Tool server failure'],
    [502, 'Provider failure'],
    [503, 'Server is busy or draining'],
    [504, 'Execution exceeded the time limit'],
  ].map(([status, description]) => [
    String(status),
    {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  ]),
);

const assetSchema: JsonObject = {
  type: 'object',
  required: ['assetId', 'filename', 'contentType', 'sizeBytes', 'sha256', 'createdAt', 'expiresAt'],
  properties: {
    assetId: { type: 'string', description: 'Opaque identifier used as kind="asset" input.' },
    filename: { type: 'string' },
    contentType: { type: 'string' },
    sizeBytes: { type: 'integer' },
    sha256: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
};

const assetPaths = (): JsonObject => ({
  '/assets': {
    post: {
      operationId: 'uploadAsset',
      summary: 'Stream a file into private storage and receive an opaque asset id.',
      description:
        'Send the raw bytes as the request body with an x-filename header. File bytes are never accepted inside JSON tool requests.',
      parameters: [
        {
          name: 'x-filename',
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description: 'Original file name; sanitised by the server.',
        },
      ],
      requestBody: {
        required: true,
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
      responses: {
        '201': {
          description: 'Stored asset metadata',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['asset'],
                properties: { asset: { $ref: '#/components/schemas/Asset' } },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
    get: {
      operationId: 'listAssets',
      summary: 'List the calling principal\u2019s unexpired assets.',
      responses: { '200': { description: 'Asset list' }, ...errorResponses },
    },
  },
  '/assets/{assetId}': {
    get: {
      operationId: 'getAsset',
      summary: 'Read asset metadata. Asset bytes are never returned.',
      parameters: [{ name: 'assetId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Asset metadata' }, ...errorResponses },
    },
    delete: {
      operationId: 'deleteAsset',
      summary: 'Delete an asset owned by the calling principal.',
      parameters: [{ name: 'assetId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '204': { description: 'Deleted' }, ...errorResponses },
    },
  },
});

const toolPath = (tool: RegisteredTool): JsonObject => ({
  post: {
    operationId: tool.name,
    summary: tool.summary,
    description:
      tool.kind === 'write'
        ? `${tool.description}\n\nPreview with dryRun=true and require explicit confirmation before execution.`
        : tool.description,
    tags: [tool.kind],
    'x-openai-isConsequential': tool.kind === 'write',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: tool.inputJsonSchema } },
    },
    responses: {
      '200': {
        description: 'Tool result',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tool', 'requestId', 'result'],
              properties: {
                tool: { type: 'string' },
                requestId: { type: 'string' },
                result: tool.outputJsonSchema,
              },
            },
          },
        },
      },
      ...errorResponses,
    },
  },
});

export const buildOpenApiDocument = (config: AppConfig, registry: ToolRegistry): JsonObject => {
  const paths: JsonObject = {
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness probe.',
        security: [],
        responses: { '200': { description: 'Process is alive' } },
      },
    },
    '/ready': {
      get: {
        operationId: 'ready',
        summary: 'Readiness probe covering configuration, jq, ripgrep, scratch space and storage.',
        security: [],
        responses: {
          '200': { description: 'Service is ready' },
          '503': { description: 'Service is draining or a dependency is unavailable' },
        },
      },
    },
    '/version': {
      get: {
        operationId: 'version',
        summary: 'Build and capability information.',
        security: [],
        responses: { '200': { description: 'Service metadata' } },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'openapi',
        summary: 'Generated OpenAPI document.',
        security: [],
        responses: { '200': { description: 'OpenAPI 3.1 document' } },
      },
    },
    '/tools': {
      get: {
        operationId: 'listTools',
        summary: 'List every registered tool and JSON Schema.',
        responses: { '200': { description: 'Tool catalogue' }, ...errorResponses },
      },
    },
    '/mcp': {
      post: {
        operationId: 'mcp',
        summary: 'Stateless Streamable HTTP MCP endpoint.',
        responses: { '200': { description: 'MCP response' }, ...errorResponses },
      },
    },
    ...assetPaths(),
  };
  for (const tool of registry.list()) paths[`/tools/${tool.name}`] = toolPath(tool);

  return {
    openapi: '3.1.0',
    info: {
      title: 'Agent Tool Server Data Cruncher',
      version: config.service.version,
      description: serverPurpose,
    },
    servers: [{ url: config.service.publicBaseUrl ?? `http://localhost:${config.http.port}` }],
    security: config.auth.mode === 'disabled' ? [] : [{ bearerAuth: [] }],
    components: {
      schemas: { Error: errorSchema, Asset: assetSchema },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Static API key supplied as a bearer token or x-api-key header.',
        },
      },
    },
    paths,
    tags: [
      { name: 'read', description: 'Read-only tools.' },
      { name: 'write', description: 'Confirmation-gated mutation tools.' },
    ],
  };
};
