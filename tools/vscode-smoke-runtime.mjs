import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const RELEASE_VERSION = /^(?:stable|1\.\d+\.\d+)$/;

export async function resolveVSCodeTestRuntimeOptions(
  environment,
  repositoryRoot,
) {
  const executablePath = environment.VSCODE_EXECUTABLE_PATH;
  if (executablePath !== undefined) {
    if (!isAbsolute(executablePath)) {
      throw new Error("VSCODE_EXECUTABLE_PATH must be absolute");
    }
    let executableStats;
    try {
      executableStats = await stat(executablePath);
    } catch (error) {
      throw new Error(
        "VSCODE_EXECUTABLE_PATH must reference an existing file",
        { cause: error },
      );
    }
    if (!executableStats.isFile()) {
      throw new Error("VSCODE_EXECUTABLE_PATH must reference an existing file");
    }
    return {
      reuseMachineInstall: false,
      vscodeExecutablePath: executablePath,
    };
  }

  const version = environment.VSCODE_TEST_VERSION ?? "stable";
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(
      "VSCODE_TEST_VERSION must be stable or an exact 1.x.x release",
    );
  }
  return {
    cachePath: join(repositoryRoot, ".vscode-test"),
    reuseMachineInstall: false,
    version,
  };
}
