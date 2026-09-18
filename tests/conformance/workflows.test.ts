import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const platformRevision = '98ec8162fb11d5c04aee9e6f7b3625a472a0180d';

const loadWorkflow = (name: string): Promise<string> =>
  readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');

describe('reusable workflow caller contracts', () => {
  it('uses stable tags and forwards every canonical release input', async () => {
    const workflow = await loadWorkflow('release');
    expect(workflow).toContain("tags:\n      - 'v*'");
    expect(workflow).not.toContain('branches: [main]');
    for (const input of ['version', 'dry_run', 'recover_github_release']) {
      expect(workflow).toMatch(new RegExp(`^      ${input}:`, 'mu'));
      expect(workflow).toMatch(new RegExp(`^      ${input}: \\$\\{\\{`, 'mu'));
    }
    expect(workflow).toContain(
      `uses: ashergarland/agent-tool-platform/.github/workflows/capability-release.yml@${platformRevision}`,
    );
    expect(workflow).toMatch(/permissions:\n\s+contents: write\n\s+id-token: write/gu);
  });

  it('grants only the permissions required by the reusable security workflow', async () => {
    const workflow = await loadWorkflow('security');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('security-events: write');
    expect(workflow).toContain('packages: read');
    expect(workflow).toContain(
      `uses: ashergarland/agent-tool-platform/.github/workflows/capability-security.yml@${platformRevision}`,
    );
    expect(workflow).not.toMatch(/contents: write|actions: write|pull-requests: write/gu);
  });

  it('enables package smoke and wires exact deployment-contract validation', async () => {
    const workflow = await loadWorkflow('ci');
    expect(workflow).toContain('run_package_smoke: true');
    expect(workflow).toContain('deployment-contract:');
    expect(workflow).toContain(`ref: ${platformRevision}`);
    expect(workflow).toContain(
      'AGENT_TOOL_PLATFORM_CHECKOUT: ${{ github.workspace }}/.agent-tool-platform',
    );
    expect(workflow).toContain('run: npm run deployment:validate');
    expect(workflow).toContain('run: npm run deployment:conformance');
    expect(workflow).toContain(
      `uses: ashergarland/agent-tool-platform/.github/workflows/capability-ci.yml@${platformRevision}`,
    );
  });
});
