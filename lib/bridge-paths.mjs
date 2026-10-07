import { homedir } from "node:os";
import { join } from "node:path";

function envPath(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bridgeRootDir() {
  if (process.platform === "win32") {
    return join(envPath("LOCALAPPDATA") || join(homedir(), "AppData", "Local"), "DeepSeekWorker");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "DeepSeekWorker");
  }
  return join(envPath("XDG_STATE_HOME") || join(homedir(), ".local", "state"), "deepseek-worker");
}

export function bridgeProfileDir() {
  return join(bridgeRootDir(), "ChatBridgeProfile");
}

export function bridgeWakeOutboxPath() {
  return envPath("DEEPSEEK_WORKER_BRIDGE_WAKE_OUTBOX_PATH") || join(bridgeRootDir(), "bridge-wake-outbox.json");
}