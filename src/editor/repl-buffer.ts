// One console's state, with no DOM anywhere near it.
//
// WHY IT IS SEPARATE. Everything that can be wrong about a console is in
// here — whether a line is copied once, whether the history remembers what
// you were typing before you walked into it, whether a cap on the
// scrollback drops the newest instead of the oldest — and none of it is
// about elements. `maiden-repl.ts` is the shell: tabs, a `<pre>`, an input
// and a scroll position. This is what a test can hold.
//
// READ BY LENGTH, NOT BY EVENT. The buffers these read from only ever grow,
// so "how much has been read" is a number and nothing can be missed: a
// console opened an hour into a session shows the whole hour, and one that
// was never opened costs nothing. An event stream would need a subscription
// per source, an unsubscribe on close, and a decision about what to do with
// what was printed while nobody was listening.

export interface ReplSource {
  /** The tab's label, and what stands in the prompt. */
  readonly name: string;
  /** The growing output buffer. */
  lines(): readonly string[];
  /** Send one line. Returns an error to echo, or null. */
  send(code: string): string | null;
}

/**
 * How much scrollback to keep, in lines.
 *
 * sclang's class-library compile alone is a few hundred lines and a long
 * session's matron output is unbounded. The page keeps all of it in the
 * array this reads FROM — nothing is lost — but a `<pre>` with a hundred
 * thousand lines in it is a page that stops scrolling.
 */
export const SCROLLBACK = 4000;

export class ReplTab {
  /** How far into `source.lines()` has been copied out. */
  private read = 0;
  /** What the console displays. */
  shown: string[] = [];
  readonly history: string[] = [];
  /** Where we are in the history, or `history.length` when not browsing. */
  private cursor = 0;
  /** What was being typed before the history was walked into. */
  private draft = "";

  constructor(
    readonly source: ReplSource,
    private readonly max = SCROLLBACK,
  ) {}

  get name(): string {
    return this.source.name;
  }

  /** Copy whatever the source has produced since last time. */
  pull(): boolean {
    const all = this.source.lines();
    if (all.length <= this.read) return false;
    this.shown.push(...all.slice(this.read));
    this.read = all.length;
    this.trim();
    return true;
  }

  /** Put text in, splitting it the way the console will show it. */
  put(text: string): void {
    this.shown.push(...text.split(/\r?\n/));
    this.trim();
  }

  /**
   * Echo, send, and echo whatever came back.
   *
   * `remember` is false for an `eval` from the editor: the history is what
   * was typed HERE, and an eval is already in the file it came from.
   */
  send(code: string, remember: boolean): string | null {
    this.put(`${this.name} > ${code}`);
    if (remember && this.history[this.history.length - 1] !== code) this.history.push(code);
    this.cursor = this.history.length;
    this.draft = "";
    const err = this.source.send(code);
    if (err !== null) this.put(err);
    this.pull();
    return err;
  }

  /** The previous line, or null when there is nowhere further back. */
  up(typing: string): string | null {
    if (this.cursor === this.history.length) this.draft = typing;
    if (this.cursor === 0) return null;
    this.cursor--;
    return this.history[this.cursor] ?? null;
  }

  /** The next line, or the draft when it walks back off the end. */
  down(): string | null {
    if (this.cursor >= this.history.length) return null;
    this.cursor++;
    return this.cursor === this.history.length ? this.draft : (this.history[this.cursor] ?? null);
  }

  /**
   * Clear the VIEW, not the buffer the page keeps.
   *
   * Clearing a console is about what you are looking at. Losing the log
   * would be a different and worse thing to do, and this cannot do it: the
   * source is somebody else's array.
   */
  clear(): void {
    this.shown = [];
  }

  /** The oldest go, because the newest are the ones being read. */
  private trim(): void {
    if (this.shown.length > this.max) this.shown = this.shown.slice(-this.max);
  }
}
