/**
 * E9-130 — THE CONSOLE SAYS WHEN, because a log that does not cannot answer
 * the only question anybody ever asks of it.
 *
 * "Certain scripts are slow" is a description. A log off a Pixel showed
 * exactly WHAT happened through a boot — every module, every engine, every
 * SuperCollider complaint — and gave no way at all to tell a stall from a
 * busy stretch, or either from a fast page with a lot to say. One column
 * fixes that, and it is subtractable: the gap between two stamps is the
 * cost of everything between them.
 *
 * SINCE THE TIME ORIGIN, not since the first line. `performance.now()`
 * counts from navigation start, so the first stamp already carries what it
 * cost to fetch, parse and start the modules — the part a log that started
 * its own clock would have reported as zero, which is the part most worth
 * knowing on a phone.
 *
 * ONE STAMP PER CALL, AND BLANKS BENEATH IT for a chunk that spans lines.
 * sclang hands over its error dumps forty lines at a time; stamping each
 * would invent forty moments out of one, and the whole point of this column
 * is that it does not invent.
 *
 * THE FORMATTING IS A PURE FUNCTION and the DOM is two calls, because the
 * tests run in node with no `document`. `stamp` is where every decision
 * lives and is tested directly; `createLog` is the part a browser has to
 * be present for, and it is verified in the page.
 */

/** Width of the seconds field: `1234.567` before it starts pushing. */
const STAMP = 7;

export interface Log {
  (line: string): void;
}

/**
 * One log call as it will appear, newline included.
 *
 * `ms` is milliseconds since the time origin — what `performance.now()`
 * returns — and comes out as seconds to three places, right-aligned so the
 * text after it stays in a column.
 */
export function stamp(line: string, ms: number): string {
  const at = (ms / 1000).toFixed(3).padStart(STAMP);
  const blank = " ".repeat(at.length);
  const lines = line.split("\n");
  let out = "";
  for (let i = 0; i < lines.length; i++) out += (i === 0 ? at : blank) + " " + lines[i] + "\n";
  return out;
}

/**
 * Attach a timestamped log to an element.
 *
 * `now` is injected so a caller can supply its own clock; production passes
 * nothing and gets `performance.now()`.
 */
export function createLog(el: HTMLElement, now: () => number = () => performance.now()): Log {
  // ONE TEXT NODE, APPENDED TO — not `textContent +=`.
  //
  // The line this replaces read the whole console back out of the DOM,
  // concatenated, and wrote all of it again: serialise, allocate, destroy
  // the node, build a new one, every time. Linear in the log so far, on
  // every line, which is quadratic over a session — and worst exactly
  // where it hurts, since an sclang backtrace is forty calls in a row at
  // the moment the log is already longest, on the slowest machine anyone
  // runs this on. `appendData` costs the length of what is added.
  //
  // `textContent` still reads back the whole console, which is what the
  // copy button wants and the only thing that ever asked for it.
  const text = document.createTextNode("");
  el.append(text);

  /**
   * E9-145 — ONE SCROLL PER FRAME, NOT ONE PER LINE.
   *
   * `el.scrollTop = el.scrollHeight` reads a layout property and then
   * writes one, which forces the browser to lay the element out there
   * and then. Once a line, that is nothing. A `kolor` log off a Pixel
   * has a hundred lines in four seconds — the script prints on every
   * grid press — and a hundred forced layouts a second on a phone is
   * not nothing.
   *
   * Coalesced onto an animation frame: however many lines arrive
   * between two frames, the console is scrolled once, which is the most
   * often anybody could see it move anyway.
   *
   * AND ONLY IF IT WAS ALREADY AT THE BOTTOM. Scrolling up through a log
   * while something is still writing to it used to be impossible — every
   * new line yanked the view back down. Reading what just went wrong is
   * the one thing this element is for.
   */
  /**
   * FOLLOWED, NOT MEASURED. Asking `scrollHeight` per line to decide
   * whether we are at the bottom is the same forced layout this is
   * avoiding, and asking AFTER appending gets the wrong answer anyway —
   * the text has already made the element taller. So the element is
   * asked once per SCROLL event, which the browser fires at most once a
   * frame and only when something actually moved. Our own scroll below
   * fires one too, which is how following resumes.
   *
   * The slack is a line or two: fractional scroll heights mean an exact
   * comparison is never true.
   */
  let follow = true;
  el.addEventListener("scroll", () => {
    follow = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  });

  let scrollQueued = false;
  const scrollSoon = (): void => {
    if (!follow || scrollQueued) return;
    scrollQueued = true;
    const go = (): void => {
      scrollQueued = false;
      el.scrollTop = el.scrollHeight;
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
    else go();
  };

  return (line: string): void => {
    text.appendData(stamp(line, now()));
    scrollSoon();
  };
}
