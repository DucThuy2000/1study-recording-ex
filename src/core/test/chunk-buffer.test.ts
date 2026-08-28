import { describe, it, expect } from "vitest";
import { MemoryChunkBuffer } from "../chunk-buffer";

function blob(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

describe("MemoryChunkBuffer", () => {
  it("accepts chunks under the cap", () => {
    const buf = new MemoryChunkBuffer(1000);
    expect(buf.push(0, blob(400))).toBe(true);
    expect(buf.push(1, blob(400))).toBe(true);
    expect(buf.readAll().map((c) => c.index)).toEqual([0, 1]);
  });

  it("drops chunks that would exceed the cap and records their index", () => {
    const buf = new MemoryChunkBuffer(1000);
    buf.push(0, blob(700));
    expect(buf.push(1, blob(700))).toBe(false);
    expect(buf.getDroppedIndices()).toEqual([1]);
    expect(buf.readAll().map((c) => c.index)).toEqual([0]);
  });

  it("keeps accepting later chunks that individually still fit after a drop", () => {
    const buf = new MemoryChunkBuffer(1000);
    buf.push(0, blob(700));
    buf.push(1, blob(700));
    expect(buf.push(2, blob(200))).toBe(true);
    expect(buf.readAll().map((c) => c.index)).toEqual([0, 2]);
  });
});
