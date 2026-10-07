import { Bot } from "./bot.ts";
import { loadConfig } from "./config.ts";
import { Forwarder } from "./forwarder.ts";
import { Ledger } from "./ledger.ts";
import { ModemManager } from "./modem.ts";

const config = loadConfig();
const ledger = new Ledger(config.stateDir);
const mm = new ModemManager();
const bot = new Bot(mm, config.channelId);
const forwarder = new Forwarder(mm, ledger, (sms, label) => bot.postSms(sms, label), config);

await bot.start(config.discordToken);
await mm.start();
mm.on("changed", () => forwarder.schedule());
const interval = setInterval(() => void forwarder.scan(), config.scanIntervalSec * 1000);

console.info(`ring-ring started (state: ${ledger.path})`);
await forwarder.scan();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    clearInterval(interval);
    mm.disconnect();
    await bot.destroy();
    process.exit(0);
  });
}
