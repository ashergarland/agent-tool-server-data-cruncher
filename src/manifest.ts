import type { CapabilityManifest } from '@agent-tool-platform/runtime/capability';
import packageManifest from '../package.json' with { type: 'json' };

export const capabilityManifest: CapabilityManifest = {
  name: 'agent-tool-server-data-cruncher',
  version: packageManifest.version,
  title: 'Data Cruncher',
  description:
    'Reduce large local JSON, JSONL, log, and text files with bounded jq and ripgrep tools.',
  documentationUrl: 'https://github.com/ashergarland/agent-tool-server-data-cruncher#readme',
};
