import { AtPort } from "./at.ts";
import { Bot } from "./bot.ts";
import { CallController } from "./calls.ts";
import { loadConfig } from "./config.ts";
import { Forwarder } from "./forwarder.ts";
import { Ledger } from "./ledger.ts";
import { ModemManager } from "./modem.ts";
import { Phone } from "./phone.ts";

const config = loadConfig();
const ledger = new Ledger(config.stateDir);
const mm = new ModemManager();
const bot = new Bot(mm, config.channelId);
const forwarder = new Forwarder(mm, ledger, (sms, label) => bot.postSms(sms, label), config);

await bot.start(config.discordToken);
await mm.start();
mm.on("changed", () => forwarder.schedule());
const interval = setInterval(() => void forwarder.scan(), config.scanIntervalSec * 1000);

let calls: CallController | undefined;
let at: AtPort | undefined;
if (config.voiceChannelId) {
  at = new AtPort(config.modemAtPort);
  // A vanished AT port (modem reset, USB replug) leaves calls dead; let systemd restart us.
  at.on("close", () => {
    console.error("AT port closed, exiting");
    process.exit(1);
  });
  at.on("error", (e: Error) => console.error(`AT port error: ${e.message}`));
  await at.open();
  const phone = new Phone(at);
  await phone.init();
  const voiceChannel = await bot.fetchVoiceChannel(config.voiceChannelId);
  calls = new CallController(phone, bot.channel!, voiceChannel, config.modemAudioPort);
  bot.buttonHandler = (interaction) => calls!.onButton(interaction);
  console.info(`calls enabled (voice channel #${voiceChannel.name})`);
}

console.info(`ring-ring started (state: ${ledger.path})`);
await forwarder.scan();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    clearInterval(interval);
    await calls?.shutdown().catch(() => {});
    at?.removeAllListeners("close");
    at?.close();
    mm.disconnect();
    await bot.destroy();
    process.exit(0);
  });
}
