export interface Config {
  discordToken: string;
  channelId: string;
  stateDir: string;
  deleteAfterForward: boolean;
  forwardExisting: boolean;
  scanIntervalSec: number;
  /** Voice channel for phone calls; calls are disabled when unset. */
  voiceChannelId: string | undefined;
  modemAtPort: string;
  modemAudioPort: string;
}

// SIM7600 USB interfaces: 02/03 are AT ports, 04 is the PCM audio port.
// ModemManager uses QMI and leaves interface 03 alone.
const SIM7600_BY_ID = "/dev/serial/by-id/usb-SimTech__Incorporated_SimTech__Incorporated_0123456789ABCDEF";

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
    voiceChannelId: process.env.VOICE_CHANNEL_ID || undefined,
    modemAtPort: process.env.MODEM_AT_PORT || `${SIM7600_BY_ID}-if03-port0`,
    modemAudioPort: process.env.MODEM_AUDIO_PORT || `${SIM7600_BY_ID}-if04-port0`,
  };
}
