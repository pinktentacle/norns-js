// E1-06 — the loud-stub registry.
//
// ADR-08: a function norns-js does not implement must be *visible* as such,
// not quietly faked. The compatibility page (E7-01) is generated from what
// this records, so the claim "these 42 things do not work" is produced by the
// running system rather than maintained by hand and gone stale.
//
// It records the first call to each name and counts the rest. First-call
// detail matters more than totals: `screen_move` is called 36 times during
// boot and tells you nothing by the second, whereas one call to `crow_send`
// is the whole story.

import type { LuaValue } from "../lua/lua.js";

export interface StubCall {
  readonly name: string;
  /** Total calls seen. */
  count: number;
  /** Arguments of the FIRST call, for the compatibility page. */
  readonly firstArgs: readonly LuaValue[];
  /** Milliseconds since the registry was created, for the first call. */
  readonly firstAt: number;
}

export type Implementation = (...args: LuaValue[]) => readonly LuaValue[] | void;

/**
 * An implementation that works the Lua stack itself, returning the number of
 * values it pushed — the same contract a C binding has.
 *
 * Two of the 178 need this and no more. `system_cmd` and `system_action` take
 * a Lua FUNCTION as their second argument and hold it until a subprocess
 * finishes (p1-api-plan §4.4). Marshalling arguments into JS values loses a
 * function, and holding one across an await needs `luaL_ref`, because Lua's
 * collector will otherwise take a closure nothing on the stack refers to.
 */
export type RawImplementation = (L: unknown) => number;

export class NornsRegistry {
  private readonly impls = new Map<string, Implementation>();
  private readonly raw = new Map<string, RawImplementation>();
  private readonly stubCalls = new Map<string, StubCall>();
  private readonly order: string[] = [];
  private readonly t0 = Date.now();

  /** Total calls across every name, stubbed or implemented. */
  private total = 0;
  private readonly callCounts = new Map<string, number>();

  /**
   * E9-200 — WHAT EACH FUNCTION COSTS ON THIS SIDE, when somebody asks.
   *
   * `timing` is false for the life of an ordinary page and the dispatcher
   * reads it once a call. Under `?profile` it is true, and one call in
   * eight of each function is timed into that function own slot; see
   * `ui/probe.ts` for why one in eight and not all of them.
   *
   * The slot is handed to the dispatcher closure when the function is
   * installed, so a timed call is two clock reads and three additions
   * with no lookup — a map lookup per call would cost more than most of
   * the functions being measured.
   */
  timing = false;
  readonly slots = new Map<string, { calls: number; timed: number; ms: number; max: number }>();

  slotFor(name: string): { calls: number; timed: number; ms: number; max: number } {
    let s = this.slots.get(name);
    if (s === undefined) {
      s = { calls: 0, timed: 0, ms: 0, max: 0 };
      this.slots.set(name, s);
    }
    return s;
  }

  /**
   * Provide a real implementation for one `_norns` function.
   *
   * Subsystems call this as they come up — screen in E2, metro in E3, engines
   * in E4 — so the set of loud stubs shrinks on its own and nothing has to be
   * deleted from a list.
   */
  implement(name: string, fn: Implementation): void {
    this.impls.set(name, fn);
  }

  implementMany(table: Record<string, Implementation>): void {
    for (const [name, fn] of Object.entries(table)) this.implement(name, fn);
  }

  implementationFor(name: string): Implementation | undefined {
    return this.impls.get(name);
  }

  /** Provide a stack-level implementation. Takes precedence over `implement`. */
  implementRaw(name: string, fn: RawImplementation): void {
    this.raw.set(name, fn);
  }

  rawImplementationFor(name: string): RawImplementation | undefined {
    return this.raw.get(name);
  }

  isImplemented(name: string): boolean {
    return this.impls.has(name) || this.raw.has(name);
  }

  /** Called by the dispatcher on every call, before the value is produced. */
  noteCall(name: string): void {
    this.total++;
    this.callCounts.set(name, (this.callCounts.get(name) ?? 0) + 1);
  }

  /** Called by the dispatcher when no implementation existed. */
  noteStub(name: string, args: readonly LuaValue[]): void {
    const seen = this.stubCalls.get(name);
    if (seen) {
      seen.count++;
      return;
    }
    this.stubCalls.set(name, {
      name,
      count: 1,
      firstArgs: args,
      firstAt: Date.now() - this.t0,
    });
    this.order.push(name);
  }

  /** Every stub that was actually reached, in the order it was first reached. */
  stubsUsed(): StubCall[] {
    return this.order.map((n) => this.stubCalls.get(n)!);
  }

  /** Call statistics for the whole surface. */
  stats(): { total: number; distinct: number; byName: Map<string, number> } {
    return { total: this.total, distinct: this.callCounts.size, byName: new Map(this.callCounts) };
  }

  reset(): void {
    this.stubCalls.clear();
    this.order.length = 0;
    this.callCounts.clear();
    this.total = 0;
  }
}
