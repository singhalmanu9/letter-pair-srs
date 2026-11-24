import { describe, expect, it } from "vitest";
import { MemoryStore, WebStorageStore, type AsyncKeyValueStore } from "../src/lib/storage";

/** Minimal in-memory implementation of the Web Storage API. */
class FakeStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

describe.each<[string, () => AsyncKeyValueStore]>([
  ["MemoryStore", () => new MemoryStore()],
  ["WebStorageStore", () => new WebStorageStore(new FakeStorage())],
])("%s", (_name, make) => {
  it("get, set, remove and list keys by prefix", async () => {
    const store = make();
    expect(await store.get("a")).toBeNull();
    await store.set("lpsrs:a", "1");
    await store.set("lpsrs:b", "2");
    await store.set("other", "3");
    expect(await store.get("lpsrs:a")).toBe("1");
    expect((await store.keys("lpsrs:")).sort()).toEqual(["lpsrs:a", "lpsrs:b"]);
    await store.remove("lpsrs:a");
    expect(await store.get("lpsrs:a")).toBeNull();
  });
});
