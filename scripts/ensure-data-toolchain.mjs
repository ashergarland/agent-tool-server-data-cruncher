import { spawnSync } from 'node:child_process';

const tools = [
  { command: 'jq', packageName: 'jq' },
  { command: 'rg', packageName: 'ripgrep' },
];

const probe = ({ command }) => {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') return false;
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} --version exited with code ${String(result.status)}`);
  }
  const version = `${result.stdout}${result.stderr}`.split(/\r?\n/u)[0]?.trim();
  process.stdout.write(`${command}: ${version || 'version output unavailable'}\n`);
  return true;
};

const run = (command, args) => {
  const result = spawnSync(command, args, {
    shell: false,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${String(result.status)}`);
  }
};

const missing = tools.filter((tool) => !probe(tool));
if (missing.length === 0) process.exit(0);

if (process.env['GITHUB_ACTIONS'] !== 'true' || process.platform !== 'linux') {
  throw new Error(
    `Missing required data tools: ${missing.map(({ command }) => command).join(', ')}. ` +
      'Install jq 1.7+ and ripgrep 14+ before running the real capability tests.',
  );
}

run('sudo', ['apt-get', 'update']);
run('sudo', ['apt-get', 'install', '--yes', ...missing.map(({ packageName }) => packageName)]);

for (const tool of tools) {
  if (!probe(tool)) throw new Error(`${tool.command} remained unavailable after installation`);
}
