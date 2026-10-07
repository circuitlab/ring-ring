export interface Config {
  discordToken: string;
  channelId: string;
  stateDir: string;
  deleteAfterForward: boolean;
  forwardExisting: boolean;
  scanIntervalSec: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function loadConfig(): Config {
  return {
    discordToken: required("DISCORD_TOKEN"),
    channelId: required("DISCORD_CHANNEL_ID"),
    stateDir: process.env.STATE_DIR || process.env.STATE_DIRECTORY || "state",
    deleteAfterForward: process.env.DELETE_AFTER_FORWARD === "1",
    forwardExisting: process.env.FORWARD_EXISTING === "1",
    scanIntervalSec: Number(process.env.SCAN_INTERVAL || 60),
  };
}
