/**
 * FetchGate — the re-enableable fetch-gating signal — and its React wiring
 * `usePaused` (gate → "hold fetching" boolean, reactive).
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { FetchGate } from "../src/react/FetchGate";
import { usePaused } from "../src/react/index";

describe("FetchGate", () => {
  it("defaults to enabled and reflects set/enable/disable", () => {
    const gate = new FetchGate();
    expect(gate.enabled).toBe(true);

    gate.disable();
    expect(gate.enabled).toBe(false);
    gate.enable();
    expect(gate.enabled).toBe(true);

    expect(new FetchGate(false).enabled).toBe(false);
  });

  it("notifies subscribers only on an actual change", () => {
    const gate = new FetchGate(true);
    const listener = vi.fn();
    const unsubscribe = gate.subscribe(listener);

    gate.set(true); // no-op — already enabled
    expect(listener).not.toHaveBeenCalled();

    gate.set(false);
    gate.set(true);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    gate.set(false);
    expect(listener).toHaveBeenCalledTimes(2); // no longer notified
  });
});

describe("usePaused", () => {
  it("is false with no opts and tracks the static pause flag", () => {
    expect(renderHook(() => usePaused(undefined)).result.current).toBe(false);
    expect(renderHook(() => usePaused({ pause: true })).result.current).toBe(true);
  });

  it("resolves a gate and re-renders when it flips", () => {
    const gate = new FetchGate(true);
    const { result } = renderHook(() => usePaused({ gate }));

    expect(result.current).toBe(false); // enabled → not paused

    act(() => gate.disable());
    expect(result.current).toBe(true); // disabled → paused

    act(() => gate.enable());
    expect(result.current).toBe(false);
  });

  it("pause: true overrides an enabled gate", () => {
    const gate = new FetchGate(true);
    const { result } = renderHook(() => usePaused({ pause: true, gate }));
    expect(result.current).toBe(true);
  });
});
