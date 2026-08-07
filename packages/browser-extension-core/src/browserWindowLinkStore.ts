import {
  MANAGED_BRIDGE_PORT_END,
  MANAGED_BRIDGE_PORT_START,
} from "@browser2ide/protocol";
import { z } from "zod";

export interface BrowserWindowLink {
  readonly url: string;
  readonly port: number;
  readonly sessionId: string;
  readonly bridgeInstanceId: string;
  readonly authToken: string;
  readonly displayLinkCode: string;
}

export interface SessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

const browserWindowIdSchema = z.number().int().nonnegative().safe();
const browserWindowLinkFields = [
  "url",
  "port",
  "sessionId",
  "bridgeInstanceId",
  "authToken",
  "displayLinkCode",
] as const;
const browserWindowLinkSchema = z
  .object({
    url: z.string(),
    port: z
      .number()
      .int()
      .min(MANAGED_BRIDGE_PORT_START)
      .max(MANAGED_BRIDGE_PORT_END),
    sessionId: z.string().min(1),
    bridgeInstanceId: z.string().uuid(),
    authToken: z.string().min(32),
    displayLinkCode: z.string().regex(/^[0-9]{5} [0-9]{2}$/),
  })
  .strict()
  .refine(({ url, port }) => url === loopbackUrl(port), {
    message: "URL must be the loopback endpoint for the saved port",
    path: ["url"],
  })
  .refine(({ displayLinkCode, port }) => {
    return displayLinkCode.slice(0, 5) === String(port);
  }, {
    message: "Display link code must use the saved port",
    path: ["displayLinkCode"],
  });

export class BrowserWindowLinkStore {
  public constructor(private readonly storage: SessionStorage) {}

  public async load(windowId: number): Promise<BrowserWindowLink | undefined> {
    const key = storageKey(windowId);
    const stored = await this.storage.get(key);
    if (!Object.hasOwn(stored, key)) {
      return undefined;
    }

    const value = stored[key];
    if (!hasOwnLinkFields(value)) {
      await this.storage.remove(key);
      return undefined;
    }

    const parsed = browserWindowLinkSchema.safeParse(value);
    if (!parsed.success) {
      await this.storage.remove(key);
      return undefined;
    }
    return parsed.data;
  }

  public async save(windowId: number, link: BrowserWindowLink): Promise<void> {
    const key = storageKey(windowId);
    if (!hasOwnLinkFields(link)) {
      throw new Error("Browser window link fields must be own properties");
    }
    const parsed = browserWindowLinkSchema.parse(link);
    await this.storage.set({ [key]: parsed });
  }

  public async remove(windowId: number): Promise<void> {
    await this.storage.remove(storageKey(windowId));
  }
}

function storageKey(windowId: number): string {
  return `browser2ide.windowLink.${browserWindowIdSchema.parse(windowId)}`;
}

function hasOwnLinkFields(
  value: unknown,
): value is Record<(typeof browserWindowLinkFields)[number], unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return browserWindowLinkFields.every((field) => Object.hasOwn(value, field));
}

function loopbackUrl(port: number): string {
  return `ws://127.0.0.1:${port}`;
}
