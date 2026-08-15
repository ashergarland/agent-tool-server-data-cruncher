import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { badRequest, forbidden, payloadTooLarge } from '../errors.js';

const sniffBytes = 8192;

export interface OpenedFile {
  readonly sizeBytes: number;
  /** First bytes of the file, used for encoding and binary detection. */
  readonly preview: Buffer;
  createStream(start?: number): Readable;
  close(): Promise<void>;
}

const fromHandle = async (handle: FileHandle, sizeBytes: number): Promise<OpenedFile> => {
  const buffer = Buffer.alloc(Math.min(sniffBytes, sizeBytes));
  if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, 0);
  return {
    sizeBytes,
    preview: buffer,
    createStream: (start = 0) => handle.createReadStream({ start, autoClose: false }),
    close: () => handle.close().catch(() => undefined),
  };
};

/** Opens an already-trusted server-side path, such as a materialised asset. */
export const openRegularFile = async (path: string, maxFileBytes: number): Promise<OpenedFile> => {
  const handle = await open(path, constants.O_RDONLY);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw badRequest('Input is not a regular file');
    if (stats.size > maxFileBytes) {
      throw payloadTooLarge('Input is larger than the configured maximum', { maxFileBytes });
    }
    return await fromHandle(handle, stats.size);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
};

export interface LocalPathOptions {
  readonly roots: readonly string[];
  readonly enabled: boolean;
  readonly maxFileBytes: number;
}

/**
 * Opens a caller-supplied path only when it resolves to a regular file contained by a configured
 * root. The returned handle is what the tool reads, so the validated file cannot be swapped for
 * another one between the check and the read.
 */
export class LocalPathResolver {
  public constructor(private readonly options: LocalPathOptions) {}

  public async open(requestedPath: string): Promise<OpenedFile> {
    if (!this.options.enabled) {
      throw forbidden('Local file paths are disabled; upload an asset and use kind="asset"');
    }
    if (requestedPath.includes('\0')) throw badRequest('File path contains an invalid character');

    const roots = await this.resolvedRoots();
    const resolved = await this.resolveWithinRoots(requestedPath, roots);

    const flags =
      typeof constants.O_NOFOLLOW === 'number'
        ? constants.O_RDONLY | constants.O_NOFOLLOW
        : constants.O_RDONLY;
    const handle = await open(resolved, flags).catch(() => {
      throw badRequest('File does not exist or is not accessible');
    });

    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw badRequest('File path must refer to a regular file');
      if (stats.size > this.options.maxFileBytes) {
        throw payloadTooLarge('File is larger than the configured maximum', {
          maxFileBytes: this.options.maxFileBytes,
        });
      }
      const link = await lstat(resolved);
      if (link.ino !== 0 && (link.ino !== stats.ino || link.dev !== stats.dev)) {
        throw badRequest('File changed while it was being validated');
      }
      return await fromHandle(handle, stats.size);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async resolvedRoots(): Promise<readonly string[]> {
    const roots = await Promise.all(
      this.options.roots.map(async (root) => realpath(resolve(root)).catch(() => undefined)),
    );
    const usable = roots.filter((root): root is string => root !== undefined);
    if (usable.length === 0) throw forbidden('No readable data root is configured');
    return usable;
  }

  private async resolveWithinRoots(
    requestedPath: string,
    roots: readonly string[],
  ): Promise<string> {
    const candidates = isAbsolute(requestedPath)
      ? [requestedPath]
      : roots.map((root) => resolve(root, requestedPath));

    for (const candidate of candidates) {
      const resolved = await realpath(candidate).catch(() => undefined);
      if (!resolved) continue;
      if (roots.some((root) => contains(root, resolved))) return resolved;
      throw forbidden('File path resolves outside the configured data roots');
    }
    throw badRequest('File does not exist or is not accessible');
  }
}

const contains = (root: string, candidate: string): boolean => {
  if (root === candidate) return false;
  const fromRoot = relative(root, candidate);
  return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
};
