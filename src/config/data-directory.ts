import path from "node:path";
import { homedir } from "node:os";

export function dataDirectory() {
  if (process.env.CODEATELIER_DATA_DIR) {
    return path.resolve(process.env.CODEATELIER_DATA_DIR);
  }

  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local")
      : process.platform === "darwin"
        ? path.join(homedir(), "Library", "Application Support")
        : process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");

  return path.join(base, "CodeAtelier");
}
