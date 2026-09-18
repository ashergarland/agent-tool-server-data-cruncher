import { badRequest } from '@agent-tool-platform/runtime/errors';

const isIdentifierStart = (character: string): boolean => /[A-Za-z_]/u.test(character);
const isIdentifierPart = (character: string): boolean => /[A-Za-z0-9_]/u.test(character);

/**
 * jq module directives can select files outside the configured data root, and jq has no switch
 * that disables module loading. The scan skips comments and strings so fields with these names
 * remain usable.
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
