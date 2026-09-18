import { describe, expect, it } from 'vitest';
import { assertNoModuleDirectives } from '../../src/domain/jq-filter.js';

const continuedComment = (nextLine: string, newline = '\n'): string =>
  `# ${'\\'}${newline}"${newline}${nextLine}`;

describe('jq module-directive lexer', () => {
  it('rejects direct import, include, module, and modulemeta loading', () => {
    expect(() => assertNoModuleDirectives('import "data" as $data; $data')).toThrow(
      /module loading/u,
    );
    expect(() => assertNoModuleDirectives('include "helpers"; helper')).toThrow(/module loading/u);
    expect(() => assertNoModuleDirectives('module {"name":"unsafe"}; .')).toThrow(
      /module loading/u,
    );
    expect(() => assertNoModuleDirectives('"secret" | modulemeta')).toThrow(/module loading/u);
  });

  it('tracks jq 1.8 backslash-newline comments with LF and CRLF', () => {
    expect(() =>
      assertNoModuleDirectives(continuedComment('import "data" as $data; $data')),
    ).toThrow(/module loading/u);
    expect(() =>
      assertNoModuleDirectives(continuedComment('include "helpers"; helper', '\r\n')),
    ).toThrow(/module loading/u);
  });

  it('allows directive words in ordinary comments, strings, fields, and bindings', () => {
    expect(() =>
      assertNoModuleDirectives(
        '# import and include are ordinary comment text\n' +
          '{note: "import \\"include\\" and \\\\ path", imported: .import, bound: $include, meta: .modulemeta}',
      ),
    ).not.toThrow();
  });

  it('tracks strings and nested interpolation without treating literal text as code', () => {
    expect(() =>
      assertNoModuleDirectives(
        '{rendered: "literal import \\({nested: "include", value: .include}.value)"}',
      ),
    ).not.toThrow();
    expect(() => assertNoModuleDirectives('"\\(import "data" as $data; $data)"')).toThrow(
      /module loading/u,
    );
  });

  it('fails closed on incomplete lexical structure', () => {
    expect(() => assertNoModuleDirectives('"unterminated')).toThrow(/incomplete/u);
    expect(() => assertNoModuleDirectives('"\\(.value"')).toThrow(/incomplete/u);
    expect(() => assertNoModuleDirectives('(.value')).toThrow(/incomplete/u);
    expect(() => assertNoModuleDirectives('(.value]')).toThrow(/incomplete/u);
  });
});
