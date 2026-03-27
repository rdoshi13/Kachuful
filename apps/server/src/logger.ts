export type LogLevel = "info" | "warn" | "error";

export const log = (level: LogLevel, message: string, meta: Record<string, unknown> = {}): void => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...meta
    })
  );
};
