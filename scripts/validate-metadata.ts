import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Metadata must describe what actually ships. Placeholder registries, unpublished package
 * identifiers and example hosted endpoints are rejected so the published entry is never a promise
 * the repository cannot keep.
 */
const placeholder = /example\.com|example\.invalid|replace\.me|replace\.invalid|changeme|your-/i;

const noPlaceholder = <T extends z.ZodType>(schema: T) =>
  schema.refine(
    (value) => !placeholder.test(JSON.stringify(value)),
    'Metadata must not contain placeholder hosts or identifiers',
  );

const serverSchema = z.object({
  $schema: z.url(),
  name: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/),
  title: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  websiteUrl: z.url().optional(),
  repository: z.object({ url: z.url(), source: z.literal('github') }),
  // Optional: only publish these once a real package or hosted endpoint exists.
  packages: z
    .array(
      z.object({
        registryType: z.enum(['npm', 'oci', 'pypi', 'nuget', 'mcpb']),
        identifier: z.string().min(1),
        version: z.string().min(1),
        transport: z.object({ type: z.enum(['stdio', 'streamable-http', 'sse']) }),
      }),
    )
    .optional(),
  remotes: z.array(z.object({ type: z.enum(['streamable-http', 'sse']), url: z.url() })).optional(),
});

const registrySchema = z.object({
  id: z.string().min(1),
  repository: z.url(),
  serverMetadata: z.string().min(1),
  categories: z.array(z.string().min(1)).min(1),
  installation: z.enum(['clone-and-build', 'container', 'npm']),
});

const load = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

const server = noPlaceholder(serverSchema).parse(await load('server.json'));
noPlaceholder(registrySchema).parse(await load('examples/central-registry-entry.json'));

const packageJson = z
  .object({ version: z.string(), name: z.string() })
  .parse(await load('package.json'));

if (server.version !== packageJson.version) {
  throw new Error(
    `server.json version ${server.version} does not match package.json ${packageJson.version}`,
  );
}
if (!server.name.endsWith(`/${packageJson.name}`)) {
  throw new Error('server.json name must end with the package name');
}

process.stdout.write('Metadata examples are valid.\n');
