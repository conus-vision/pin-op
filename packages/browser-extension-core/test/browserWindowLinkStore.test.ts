import { describe, expect, it } from "vitest";
import {
  BrowserWindowLinkStore,
  type BrowserWindowLink,
  type SessionStorage,
} from "../src/index.js";

const INSTANCE_A = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const INSTANCE_B = "e76bb54e-f1fc-4d76-844c-554a283b5291";
const AUTH_TOKEN = "a".repeat(32);

describe("BrowserWindowLinkStore", () => {
  it("isolates links by browser window", async () => {
    const storage = new MemorySessionStorage();
    const store = new BrowserWindowLinkStore(storage);
    const first = link({ bridgeInstanceId: INSTANCE_A });
    const second = link({
      port: 48_736,
      bridgeInstanceId: INSTANCE_B,
      sessionId: "session-20",
    });

    await store.save(10, first);
    await store.save(20, second);

    await expect(store.load(10)).resolves.toEqual(first);
    await expect(store.load(20)).resolves.toEqual(second);
    expect(storage.values).toEqual({
      "pin-op.windowLink.10": first,
      "pin-op.windowLink.20": second,
    });
  });

  it("treats an inherited storage key as absent", async () => {
    const key = "pin-op.windowLink.10";
    const removals: string[] = [];
    const storage: SessionStorage = {
      async get() {
        return Object.create({ [key]: link() }) as Record<string, unknown>;
      },
      async set() {},
      async remove(removedKey) {
        removals.push(removedKey);
      },
    };
    const store = new BrowserWindowLinkStore(storage);

    await expect(store.load(10)).resolves.toBeUndefined();
    expect(removals).toEqual([]);
  });

  it("removes an own storage record whose link fields are inherited", async () => {
    const key = "pin-op.windowLink.10";
    const storage = new MemorySessionStorage({
      [key]: Object.create(link()) as BrowserWindowLink,
    });
    const store = new BrowserWindowLinkStore(storage);

    await expect(store.load(10)).resolves.toBeUndefined();
    expect(storage.removals).toEqual([key]);
    expect(storage.values[key]).toBeUndefined();
  });

  it("rejects a saved link whose fields are inherited", async () => {
    const storage = new MemorySessionStorage();
    const store = new BrowserWindowLinkStore(storage);
    const forged = Object.create(link()) as BrowserWindowLink;

    await expect(store.save(10, forged)).rejects.toThrow();
    expect(storage.values).toEqual({});
  });

  it("retains only the formatted code in extension session storage", async () => {
    const storage = new MemorySessionStorage();
    const store = new BrowserWindowLinkStore(storage);

    await store.save(10, link());

    const serialized = JSON.stringify(storage.values);
    expect(serialized).toContain('"displayLinkCode":"48735 07"');
    expect(serialized).not.toContain("4873507");
    expect(serialized).not.toContain('"pin"');
    expect(serialized).not.toContain('"value"');
    expect(serialized).not.toContain('"rawCode"');
  });

  it("does not survive a new browser session storage instance", async () => {
    const firstSession = new BrowserWindowLinkStore(new MemorySessionStorage());
    await firstSession.save(10, link());

    const restartedSession = new BrowserWindowLinkStore(
      new MemorySessionStorage(),
    );

    await expect(restartedSession.load(10)).resolves.toBeUndefined();
  });

  it.each([
    ["remote URL", { url: "ws://192.0.2.10:48735" }],
    ["mismatched URL port", { url: "ws://127.0.0.1:48736" }],
    ["port below managed range", { port: 48_734, url: "ws://127.0.0.1:48734" }],
    ["port above managed range", { port: 48_835, url: "ws://127.0.0.1:48835" }],
    ["out-of-range port", { port: 65_536 }],
    ["empty session ID", { sessionId: "" }],
    ["invalid bridge instance ID", { bridgeInstanceId: "instance-a" }],
    ["short auth token", { authToken: "short" }],
    ["unformatted display code", { displayLinkCode: "4873507" }],
    ["display code for another port", { displayLinkCode: "48736 07" }],
    ["unknown field", { pin: "07" }],
  ])("rejects a saved link with %s", async (_label, override) => {
    const storage = new MemorySessionStorage();
    const store = new BrowserWindowLinkStore(storage);
    const candidate = { ...link(), ...override };

    await expect(store.save(10, candidate)).rejects.toThrow();
    expect(storage.values).toEqual({});
  });

  it.each([
    ["remote URL", { url: "ws://example.test:48735" }],
    ["mismatched URL port", { url: "ws://127.0.0.1:48736" }],
    ["stale port below managed range", {
      port: 48_734,
      url: "ws://127.0.0.1:48734",
    }],
    ["stale port above managed range", {
      port: 48_835,
      url: "ws://127.0.0.1:48835",
    }],
    ["unknown field", { rawCode: "4873507" }],
    ["short token", { authToken: "short" }],
  ])("cleans up a loaded record with %s", async (_label, override) => {
    const key = "pin-op.windowLink.10";
    const storage = new MemorySessionStorage({
      [key]: { ...link(), ...override },
      "pin-op.windowLink.20": link({
        port: 48_736,
        bridgeInstanceId: INSTANCE_B,
      }),
    });
    const store = new BrowserWindowLinkStore(storage);

    await expect(store.load(10)).resolves.toBeUndefined();
    expect(storage.removals).toEqual([key]);
    expect(storage.values[key]).toBeUndefined();
    expect(storage.values["pin-op.windowLink.20"]).toBeDefined();
  });

  it("removes only the closed browser window link", async () => {
    const storage = new MemorySessionStorage();
    const store = new BrowserWindowLinkStore(storage);
    await store.save(10, link());
    await store.save(
      20,
      link({ port: 48_736, bridgeInstanceId: INSTANCE_B }),
    );

    await store.remove(10);

    await expect(store.load(10)).resolves.toBeUndefined();
    await expect(store.load(20)).resolves.toMatchObject({
      bridgeInstanceId: INSTANCE_B,
    });
    expect(storage.removals).toEqual(["pin-op.windowLink.10"]);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid browser window ID %s",
    async (windowId) => {
      const storage = new MemorySessionStorage();
      const store = new BrowserWindowLinkStore(storage);

      await expect(store.load(windowId)).rejects.toThrow();
      await expect(store.save(windowId, link())).rejects.toThrow();
      await expect(store.remove(windowId)).rejects.toThrow();
      expect(storage.values).toEqual({});
      expect(storage.removals).toEqual([]);
    },
  );
});

class MemorySessionStorage implements SessionStorage {
  public readonly values: Record<string, unknown>;
  public readonly removals: string[] = [];

  public constructor(initial: Record<string, unknown> = {}) {
    this.values = { ...initial };
  }

  public async get(key: string): Promise<Record<string, unknown>> {
    return Object.hasOwn(this.values, key) ? { [key]: this.values[key] } : {};
  }

  public async set(values: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, values);
  }

  public async remove(key: string): Promise<void> {
    this.removals.push(key);
    delete this.values[key];
  }
}

function link(
  override: Partial<BrowserWindowLink> = {},
): BrowserWindowLink {
  const port = override.port ?? 48_735;
  return {
    url: override.url ?? `ws://127.0.0.1:${port}`,
    port,
    sessionId: override.sessionId ?? "session-10",
    bridgeInstanceId: override.bridgeInstanceId ?? INSTANCE_A,
    authToken: override.authToken ?? AUTH_TOKEN,
    displayLinkCode: override.displayLinkCode ?? `${port} 07`,
  };
}
