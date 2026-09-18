#!/usr/bin/env node
import { startStdioAgentToolApplication } from '@agent-tool-platform/runtime/capability';
import { capability } from './capability.js';

await startStdioAgentToolApplication(capability, {
  env: {
    ...process.env,
    DATA_ROOT: process.env['DATA_ROOT']?.trim() || process.cwd(),
  },
});
