import type {
  Disposable,
  RefreshClassifier,
  RefreshClassifierInput,
  RefreshMode,
} from "@pin-op/plugin-api";

const MAX_EXTERNAL_CLASSIFIERS = 64;
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
  readonly error: unknown;
}

export interface RefreshClassifierRegistryOptions {
  readonly onError?: (report: RefreshClassifierErrorReport) => void;
}

export class RefreshClassifierRegistry {
  private readonly classifiers = new Map<string, RefreshClassifier>();

  public constructor(
    private readonly options: RefreshClassifierRegistryOptions = {},
  ) {}

  public register(classifier: RefreshClassifier): Disposable {
    if (this.classifiers.has(classifier.id)) {
      throw new Error(
        `Refresh classifier "${classifier.id}" is already registered`,
      );
    }
    if (this.classifiers.size >= MAX_EXTERNAL_CLASSIFIERS) {
      throw new Error(
        `At most ${MAX_EXTERNAL_CLASSIFIERS} refresh classifiers may be registered`,
      );
    }

    this.classifiers.set(classifier.id, classifier);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.classifiers.delete(classifier.id);
      },
    };
  }

  public classify(input: RefreshClassifierInput): RefreshMode | undefined {
    const classifierInput = Object.freeze({
      uri: input.uri,
      languageId: input.languageId,
    });
    let result = classifyBuiltIn(classifierInput.uri);

    const classifiers = [...this.classifiers.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );
    for (const classifier of classifiers) {
      try {
        result = strongerMode(result, classifier.classify(classifierInput));
      } catch (error) {
        this.reportError({ classifierId: classifier.id, error });
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
