import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '../../src/tools/registry.js';
import { serverInstructions } from '../../src/tools/guidance.js';

const registry = createToolRegistry();
const describedTools = registry.list().map((tool) => ({
  name: tool.name,
  text: `${tool.title} ${tool.summary} ${tool.description}`.toLowerCase(),
}));

const tokens = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 3);

/** Deterministic lexical router used to check that descriptions carry the right routing signals. */
const bestTool = (scenario: string): string => {
  const terms = tokens(scenario);
  const scored = describedTools
    .map((tool) => ({
      name: tool.name,
      score: terms.filter((term) => tool.text.includes(term)).length / terms.length,
    }))
    .sort((left, right) => right.score - left.score);
  return scored[0]!.name;
};

const negativeSentences = [
  ...describedTools.map((tool) => tool.text),
  serverInstructions.toLowerCase(),
]
  .join(' ')
  .split(/(?<=\.)\s+/)
  .filter((sentence) => sentence.includes('do not use') || sentence.includes('skip them'))
  .join(' ');

describe('tool routing', () => {
  it.each([
    ['extract the customer ids from a large json export', 'query_json_jq'],
    ['count how many orders have status failed in a huge jsonl file', 'query_json_jq'],
    ['group the json records by region and return only those fields', 'query_json_jq'],
    ['find every line matching a regular expression in a large log file', 'ripgrep_search'],
    ['search the application log text for stack traces', 'ripgrep_search'],
  ])('routes %s to %s', (scenario, expected) => {
    expect(bestTool(scenario)).toBe(expected);
  });

  it.each([
    ['images'],
    ['arbitrary code execution'],
    ['multi-file analytics'],
    ['plotting'],
    ['dataframes'],
  ])('warns against %s', (unsupported) => {
    expect(negativeSentences).toContain(unsupported);
  });

  it('tells agents to prefer the server over pasting large files into context', () => {
    expect(serverInstructions).toContain(
      'Call Data Cruncher before attaching or pasting a large file into native model context',
    );
  });

  it('asks for narrow filters, patterns and small limits', () => {
    for (const tool of describedTools) {
      expect(tool.text).toContain('narrow');
    }
    expect(serverInstructions.toLowerCase()).toContain('small result limit');
  });

  it('never claims general analytics capability', () => {
    const claims = ['dashboard', 'machine learning', 'sql', 'spreadsheet', 'general analytics'];
    for (const tool of describedTools) {
      for (const claim of claims) expect(tool.text).not.toContain(claim);
    }
  });

  it('documents both input reference kinds', () => {
    expect(serverInstructions).toContain('"kind": "local_path"');
    expect(serverInstructions).toContain('"kind": "asset"');
  });
});
