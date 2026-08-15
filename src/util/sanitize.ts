/**
 * Child stderr can contain fragments of caller data and absolute paths. Only messages that are
 * known to describe caller-supplied expressions are surfaced, and always through this filter.
 */
const maxLength = 400;

const isControlCode = (code: number): boolean => code < 0x20 || code === 0x7f;

const replaceControlCharacters = (value: string, replacement: string, keep: string): string => {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    result += !isControlCode(code) || keep.includes(character) ? character : replacement;
  }
  return result;
};

export const sanitizeStderr = (stderr: string): string =>
  replaceControlCharacters(stderr.split('\n').slice(0, 3).join(' '), ' ', '')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/(^|\s)\/[^\s"']+/g, '$1<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

/** Removes control characters so returned lines cannot corrupt or spoof downstream rendering. */
export const sanitizeLine = (line: string): string =>
  replaceControlCharacters(line.replace(/\r/g, ''), '\uFFFD', '\n\t');
