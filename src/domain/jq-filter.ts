import { badRequest } from '@agent-tool-platform/runtime/errors';

const isIdentifierStart = (character: string): boolean => /[A-Za-z_]/u.test(character);
const isIdentifierPart = (character: string): boolean => /[A-Za-z0-9_]/u.test(character);

type Delimiter = '(' | '[' | '{' | 'interpolation';

interface CodeFrame {
  readonly kind: 'code';
  readonly delimiters: Delimiter[];
}

interface StringFrame {
  readonly kind: 'string';
}

interface CommentFrame {
  readonly kind: 'comment';
}

type LexerFrame = CodeFrame | StringFrame | CommentFrame;

const moduleLoadingTokens = new Set(['import', 'include', 'module', 'modulemeta']);

const matchingDelimiter: Readonly<Record<string, Delimiter>> = {
  ')': '(',
  ']': '[',
  '}': '{',
};

const consumeIdentifier = (filter: string, start: number): number => {
  let index = start;
  while (index < filter.length && isIdentifierPart(filter[index] as string)) index += 1;
  return index;
};

const consumeQualifiedIdentifier = (filter: string, start: number): number => {
  let index = consumeIdentifier(filter, start);
  while (
    filter[index] === ':' &&
    filter[index + 1] === ':' &&
    isIdentifierStart(filter[index + 2] ?? '')
  ) {
    index = consumeIdentifier(filter, index + 2);
  }
  return index;
};

const rejectModuleDirective = (): never => {
  throw badRequest(
    'jq module loading (import/include/module/modulemeta) is not allowed because it can read files outside the requested input',
  );
};

const rejectAmbiguousFilter = (): never => {
  throw badRequest('The jq filter has an incomplete string, interpolation, or delimiter');
};

/**
 * jq module directives can select files outside the configured data root, and jq has no switch
 * that disables module loading. This models the jq 1.7/1.8 lexical states relevant to directives,
 * including jq 1.8 backslash-newline comment continuation and code inside string interpolation.
 */
export const assertNoModuleDirectives = (filter: string): void => {
  const frames: LexerFrame[] = [{ kind: 'code', delimiters: [] }];
  let index = 0;

  while (index < filter.length) {
    const character = filter[index] as string;
    const frame = frames.at(-1);
    if (!frame) throw new Error('jq filter lexer lost its root frame');

    if (frame.kind === 'comment') {
      if (character === '\\') {
        if (filter[index + 1] === '\\') {
          index += 2;
          continue;
        }
        if (filter[index + 1] === '\n') {
          index += 2;
          continue;
        }
        if (filter[index + 1] === '\r' && filter[index + 2] === '\n') {
          index += 3;
          continue;
        }
        index += 1;
        continue;
      }
      if (character === '\n') {
        frames.pop();
        index += 1;
        continue;
      }
      if (character === '\r' && filter[index + 1] === '\n') {
        frames.pop();
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (frame.kind === 'string') {
      if (character === '\\') {
        if (filter[index + 1] === '(') {
          frames.push({ kind: 'code', delimiters: ['interpolation'] });
          index += 2;
          continue;
        }
        index += Math.min(2, filter.length - index);
        continue;
      }
      if (character === '"') frames.pop();
      index += 1;
      continue;
    }

    if (character === '#') {
      frames.push({ kind: 'comment' });
      index += 1;
      continue;
    }

    if (character === '"') {
      frames.push({ kind: 'string' });
      index += 1;
      continue;
    }

    if (character === '(' || character === '[' || character === '{') {
      frame.delimiters.push(character);
      index += 1;
      continue;
    }

    if (character === ')' || character === ']' || character === '}') {
      const current = frame.delimiters.at(-1);
      if (character === ')' && current === 'interpolation') {
        frames.pop();
      } else if (current === matchingDelimiter[character]) {
        frame.delimiters.pop();
      } else {
        rejectAmbiguousFilter();
      }
      index += 1;
      continue;
    }

    if (
      character === '.' &&
      filter[index + 1] !== '.' &&
      isIdentifierStart(filter[index + 1] ?? '')
    ) {
      index = consumeIdentifier(filter, index + 1);
      continue;
    }

    if (character === '$' && isIdentifierStart(filter[index + 1] ?? '')) {
      index = consumeQualifiedIdentifier(filter, index + 1);
      continue;
    }

    if (character === '@' && isIdentifierStart(filter[index + 1] ?? '')) {
      index = consumeIdentifier(filter, index + 1);
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index;
      index = consumeQualifiedIdentifier(filter, start);
      const word = filter.slice(start, index);
      if (moduleLoadingTokens.has(word)) rejectModuleDirective();
      continue;
    }

    index += 1;
  }

  if (frames.at(-1)?.kind === 'comment') frames.pop();
  const root = frames[0];
  if (frames.length !== 1 || root?.kind !== 'code' || root.delimiters.length !== 0) {
    rejectAmbiguousFilter();
  }
};
