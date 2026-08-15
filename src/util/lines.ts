/**
 * Splits a byte stream into lines without ever buffering more than `maxLineBytes`. Lines that
 * exceed the cap are discarded and counted, so hostile input cannot grow memory without bound.
 */
export class LineSplitter {
  private buffer: Buffer = Buffer.alloc(0);
  private skipping = false;
  private dropped = 0;

  public constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: string) => boolean | void,
  ) {}

  public get droppedLines(): number {
    return this.dropped;
  }

  /** Returns false once the consumer signals that it has seen enough. */
  public push(chunk: Buffer): boolean {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const index = this.buffer.indexOf(0x0a);
      if (index < 0) break;
      const line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      if (line.length > this.maxLineBytes) {
        this.dropped += 1;
        continue;
      }
      if (this.onLine(line.toString('utf8')) === false) return false;
    }
    if (this.buffer.length > this.maxLineBytes) {
      this.buffer = Buffer.alloc(0);
      this.skipping = true;
      this.dropped += 1;
    }
    return true;
  }

  public flush(): void {
    if (this.skipping || this.buffer.length === 0) return;
    this.onLine(this.buffer.toString('utf8'));
    this.buffer = Buffer.alloc(0);
  }
}
