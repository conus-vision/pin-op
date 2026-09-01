import { describe, expect, it, vi } from "vitest";
import { readPanelClipboardText } from "../src/panelClipboard.js";

describe("readPanelClipboardText", () => {
  it("reads through the asynchronous API and leaves the document alone", async () => {
    const document = fakeDocument();

    await expect(readPanelClipboardText({
      document: document.document,
      clipboard: { readText: () => Promise.resolve("48735 07") },
    })).resolves.toBe("48735 07");

    expect(document.created).toBe(0);
    expect(document.commands).toEqual([]);
  });

  it("falls back to the editing command when the frame is refused the read", async () => {
    // What a DevTools panel gets: the toolbox embeds it cross-origin without
    // delegating `clipboard-read`, so the asynchronous read is refused however
    // the extension is permitted.
    const document = fakeDocument({ pasted: "48735 07" });

    await expect(readPanelClipboardText({
      document: document.document,
      clipboard: {
        readText: () => Promise.reject(
          new DOMException("Read permission denied.", "NotAllowedError"),
        ),
      },
    })).resolves.toBe("48735 07");

    expect(document.commands).toEqual(["paste"]);
    // The target is removed and the pressed control keeps its focus.
    expect(document.attached).toBe(0);
    expect(document.focused.at(-1)).toBe("paste-button");
  });

  it("falls back where the panel has no clipboard object at all", async () => {
    const document = fakeDocument({ pasted: "1234567" });

    await expect(readPanelClipboardText({
      document: document.document,
      clipboard: undefined,
    })).resolves.toBe("1234567");
  });

  it("reports the refusal when neither path can read", async () => {
    const document = fakeDocument({ pasteSucceeds: false });
    const refusal = new DOMException("Read permission denied.", "NotAllowedError");

    await expect(readPanelClipboardText({
      document: document.document,
      clipboard: { readText: () => Promise.reject(refusal) },
    })).rejects.toBe(refusal);

    expect(document.attached).toBe(0);
  });

  it("reports the refusal where the command is gone", async () => {
    const document = fakeDocument({ execCommand: false });
    const refusal = new Error("refused");

    await expect(readPanelClipboardText({
      document: document.document,
      clipboard: { readText: () => Promise.reject(refusal) },
    })).rejects.toBe(refusal);

    expect(document.created).toBe(0);
  });
});

function fakeDocument(options: {
  readonly pasted?: string;
  readonly pasteSucceeds?: boolean;
  readonly execCommand?: boolean;
} = {}) {
  const state = { created: 0, attached: 0, commands: [] as string[], focused: ["paste-button"] };
  const body = {
    append(node: { attached: boolean }) {
      state.attached += 1;
      node.attached = true;
    },
  };
  const active = {
    focus: () => {
      state.focused.push("paste-button");
    },
  };
  const document = {
    body,
    activeElement: active,
    createElement(tagName: string) {
      expect(tagName).toBe("textarea");
      state.created += 1;
      return {
        attached: false,
        value: "",
        style: {} as Record<string, string>,
        setAttribute: vi.fn(),
        focus() {
          state.focused.push("clipboard-target");
        },
        remove() {
          if (this.attached) state.attached -= 1;
          this.attached = false;
        },
      };
    },
    ...(options.execCommand === false ? {} : {
      execCommand(command: string, _ui?: boolean, _value?: string) {
        state.commands.push(command);
        if (options.pasteSucceeds === false) return false;
        const target = state.focused.at(-1) === "clipboard-target";
        if (!target) return false;
        currentTarget.value = options.pasted ?? "";
        return true;
      },
    }),
  };
  // The command pastes into whatever holds focus; the fake needs the same link.
  let currentTarget = { value: "" } as { value: string };
  const originalCreate = document.createElement.bind(document);
  document.createElement = (tagName: string) => {
    const element = originalCreate(tagName);
    currentTarget = element;
    return element;
  };
  return {
    document: document as unknown as Document,
    get created() {
      return state.created;
    },
    get attached() {
      return state.attached;
    },
    get commands() {
      return state.commands;
    },
    get focused() {
      return state.focused;
    },
  };
}
