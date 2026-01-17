let debugLogs: string[] = [];

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

export function setupDebugLogging(debug: boolean) {
  debugLogs = [];

  if (debug) {
    console.log = (...args) => {
      debugLogs.push(
        args.map((arg) =>
          typeof arg === "object" ? JSON.stringify(arg) : String(arg)
        ).join(" "),
      );
      originalConsoleLog.apply(console, args);
    };

    console.error = (...args) => {
      debugLogs.push(
        "[ERROR] " + args.map((arg) =>
          typeof arg === "object" ? JSON.stringify(arg) : String(arg)
        ).join(" "),
      );
      originalConsoleError.apply(console, args);
    };
  } else {
    restoreConsole();
  }
}

export function restoreConsole() {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
}

export function getDebugLogs(): string[] {
  return debugLogs;
}
