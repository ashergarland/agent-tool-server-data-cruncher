import { badRequest } from '../errors.js';

const isIdentifierStart = (character: string): boolean => /[A-Za-z_]/.test(character);
const isIdentifierPart = (character: string): boolean => /[A-Za-z0-9_]/.test(character);

/**
 * jq's module system reads files chosen by the program text:
 *
 *   import "secret" as $s {search: "/etc"}; $s
 *
 * The `search` metadata overrides `HOME` and the default search path, so a filter alone can read
 * any `.json` or `.jq` file the process can open, bypassing every data-root and asset check. jq has
 * no flag to disable module loading, so the directives are rejected before execution.
 *
 * The scan skips comments and string literals, and ignores `.import`/`$include`, so filters that
 * merely touch a field or variable with those names still work.
 */
export const assertNoModuleDirectives = (filter: string): void => {
  let index = 0;
  while (index < filter.length) {
    const character = filter[index] as string;

    if (character === '#') {
      while (index < filter.length && filter[index] !== '\n') index += 1;
      continue;
    }

    if (character === '"') {
      index += 1;
      while (index < filter.length) {
        if (filter[index] === '\\') {
          index += 2;
          continue;
        }
        if (filter[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index;
      while (index < filter.length && isIdentifierPart(filter[index] as string)) index += 1;
      const word = filter.slice(start, index);
      const previous = start > 0 ? filter[start - 1] : '';
      if ((word === 'import' || word === 'include') && previous !== '.' && previous !== '$') {
        throw badRequest(
          'jq module directives (import/include) are not allowed because they read files outside the requested input',
        );
      }
      continue;
    }

    index += 1;
  }
};
