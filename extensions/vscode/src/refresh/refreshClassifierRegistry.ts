import type {
  Disposable,
  RefreshClassifier,
  RefreshClassifierInput,
  RefreshMode,
} from "@pin-op/plugin-api";

const MAX_EXTERNAL_CLASSIFIERS = 64;
const MAX_CLASSIFIER_ID_LENGTH = 128;
const STYLE_SUFFIXES = [".css", ".scss", ".sass", ".less"] as const;
const RELOAD_SUFFIXES = [
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".php",
] as const;

export interface RefreshClassifierErrorReport {
  readonly classifierId: string;
  readonly failure: "classification-failed";
}

export interface RefreshClassifierRegistryOptions {
  readonly onError?: (report: RefreshClassifierErrorReport) => void;
}

interface RegisteredClassifier {
  readonly id: string;
  readonly classifier: RefreshClassifier;
}

export class RefreshClassifierRegistry {
  private readonly classifiers = new Map<string, RegisteredClassifier>();

  public constructor(
    private readonly options: RefreshClassifierRegistryOptions = {},
  ) {}

  public register(classifier: RefreshClassifier): Disposable {
    const id = captureClassifierId(classifier);
    if (this.classifiers.has(id)) {
      throw new Error(
        `Refresh classifier "${id}" is already registered`,
      );
    }
    if (this.classifiers.size >= MAX_EXTERNAL_CLASSIFIERS) {
      throw new Error(
        `At most ${MAX_EXTERNAL_CLASSIFIERS} refresh classifiers may be registered`,
      );
    }

    const entry: RegisteredClassifier = { id, classifier };
    this.classifiers.set(id, entry);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.classifiers.get(id) === entry) this.classifiers.delete(id);
      },
    };
  }

  public classify(input: RefreshClassifierInput): RefreshMode | undefined {
    const classifierInput = Object.freeze({
      uri: input.uri,
      languageId: input.languageId,
    });
    let result = classifyBuiltIn(classifierInput.uri);

    const entries = [...this.classifiers.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );
    for (const entry of entries) {
      try {
        result = strongerMode(
          result,
          entry.classifier.classify(classifierInput),
        );
      } catch {
        this.reportError(Object.freeze({
          classifierId: entry.id,
          failure: "classification-failed",
        }));
      }
    }
    return result;
  }

  private reportError(report: RefreshClassifierErrorReport): void {
    try {
      this.options.onError?.(report);
    } catch {
      // Error reporting cannot prevent independent classifiers from running.
    }
  }
}

function captureClassifierId(classifier: RefreshClassifier): string {
  let id: unknown;
  try {
    id = classifier.id;
  } catch {
    throw new Error("Refresh classifier ID could not be read");
  }

  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    id.length > MAX_CLASSIFIER_ID_LENGTH
  ) {
    throw new Error(
      `Refresh classifier ID must be a non-empty string of at most ${MAX_CLASSIFIER_ID_LENGTH} characters`,
    );
  }
  return id;
}

function classifyBuiltIn(uri: string): RefreshMode | undefined {
  let pathname: string;
  try {
    pathname = new URL(uri).pathname.toLowerCase();
  } catch {
    return undefined;
  }

  if (STYLE_SUFFIXES.some((suffix) => pathname.endsWith(suffix))) {
    return "styles";
  }
  if (RELOAD_SUFFIXES.some((suffix) => pathname.endsWith(suffix))) {
    return "reload";
  }
  return undefined;
}

function strongerMode(
  current: RefreshMode | undefined,
  candidate: RefreshMode | undefined,
): RefreshMode | undefined {
  if (current === "reload" || candidate === "reload") return "reload";
  if (current === "styles" || candidate === "styles") return "styles";
  return undefined;
}
