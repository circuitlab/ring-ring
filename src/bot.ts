import {
  type ButtonInteraction, type ChatInputCommandInteraction, Client, EmbedBuilder, Events, GatewayIntentBits,
  MessageFlags, type SendableChannels, SlashCommandBuilder, type VoiceBasedChannel,
} from "discord.js";
import { checkDialNumber } from "./calls.ts";
import type { ModemManager, Sms } from "./modem.ts";

// Roughly 10 UCS-2 segments; caps the cost of a single command.
const SMS_MAX_LENGTH = 670;
const PHONE_NUMBER = /^\+?[0-9]{3,20}$/;

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("call")
    .setDescription("Call a phone number and bridge it into the voice channel")
    .addStringOption((o) =>
      o.setName("to").setDescription("Domestic number, e.g. 09012345678 (prefix 184 to hide caller ID)").setRequired(true)),
  new SlashCommandBuilder().setName("status").setDescription("Show modem status"),
  new SlashCommandBuilder()
    .setName("sms")
    .setDescription("Send an SMS from the modem")
    .addStringOption((o) =>
      o.setName("to").setDescription("Phone number, e.g. 09012345678 or +819012345678").setRequired(true))
    .addStringOption((o) =>
      o.setName("text").setDescription("Message text").setRequired(true).setMaxLength(SMS_MAX_LENGTH)),
];

/** ModemManager gives e.g. '2026-10-07T17:22:23+09'; Discord wants full ISO 8601. */
export function normalizeTimestamp(ts: string): Date | undefined {
  const m = ts.match(/^(.*[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/);
  if (!m) return undefined;
  const date = new Date(`${m[1]}${m[2]}:${m[3] ?? "00"}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function smsEmbed(sms: Sms, modemLabel: string): EmbedBuilder {
  let body: string;
  if (sms.text) {
    body = sms.text;
  } else if (sms.data.length) {
    body = `(binary SMS, ${sms.data.length} bytes)\n\`\`\`\n${sms.data.toString("hex").slice(0, 1800)}\n\`\`\``;
  } else {
    body = "(empty message)";
  }
  return new EmbedBuilder()
    .setTitle(`☎️ SMS from ${sms.number || "unknown"}`)
    .setDescription(body.slice(0, 4096))
    .setFooter({ text: modemLabel })
    .setTimestamp(normalizeTimestamp(sms.timestamp) ?? null);
}

export class Bot {
  // GuildVoiceStates is needed to join voice channels.
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  channel: SendableChannels | undefined;
  /** Set by the call controller to receive button clicks. */
  buttonHandler: ((interaction: ButtonInteraction) => Promise<void>) | undefined;
  /** Set by the call controller to place outgoing calls; /call is disabled without it. */
  dialHandler: ((interaction: ChatInputCommandInteraction, number: string) => Promise<void>) | undefined;
  private mm: ModemManager;
  private channelId: string;

  constructor(mm: ModemManager, channelId: string) {
    this.mm = mm;
    this.channelId = channelId;
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isButton() && this.buttonHandler) {
        this.buttonHandler(interaction).catch((e) => {
          console.error(`button ${interaction.customId} failed: ${(e as Error).message}`);
        });
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      this.handleCommand(interaction).catch((e) => {
        console.error(`/${interaction.commandName} failed: ${(e as Error).message}`);
      });
    });
  }

  async start(token: string): Promise<void> {
    const ready = new Promise<void>((resolve) => this.client.once(Events.ClientReady, () => resolve()));
    await this.client.login(token);
    await ready;

    const channel = await this.client.channels.fetch(this.channelId);
    if (!channel?.isSendable() || !("guild" in channel)) {
      throw new Error(`channel ${this.channelId} is not a guild text channel`);
    }
    this.channel = channel;
    // Guild commands update instantly, unlike global ones.
    await channel.guild.commands.set(COMMANDS.map((c) => c.toJSON()));
    console.info(`logged in as ${this.client.user?.tag}, posting to #${channel.name}`);
  }

  async fetchVoiceChannel(id: string): Promise<VoiceBasedChannel> {
    const channel = await this.client.channels.fetch(id);
    if (!channel?.isVoiceBased()) throw new Error(`channel ${id} is not a voice channel`);
    return channel;
  }

  async postSms(sms: Sms, modemLabel: string): Promise<void> {
    if (!this.channel) throw new Error("bot not ready");
    await this.channel.send({ embeds: [smsEmbed(sms, modemLabel)], allowedMentions: { parse: [] } });
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
      case "status":
        return this.status(interaction);
      case "call":
        return this.call(interaction);
      case "sms":
        return this.sendSms(interaction);
    }
  }

  private async status(interaction: ChatInputCommandInteraction): Promise<void> {
    const modems = await this.mm.modems();
    const embed = new EmbedBuilder().setTitle("☎️ Modem status");
    if (!modems.length) embed.setDescription("No modem found.");
    for (const m of modems) {
      embed.addFields({
        name: `${m.model} (${m.ownNumbers.join(", ") || "?"})`,
        value: [
          `Operator: ${m.operator || "-"}`,
          `Network: ${m.accessTech}`,
          `Signal: ${m.signalQuality}%`,
          `SMS on modem: ${m.messages.length}`,
        ].join("\n"),
      });
    }
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  private async call(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.dialHandler) {
      await interaction.reply({ content: "Calls are disabled.", flags: MessageFlags.Ephemeral });
      return;
    }
    // Access control: only members of the (private) channel may call.
    if (interaction.channelId !== this.channelId) {
      await interaction.reply({ content: `Use this command in <#${this.channelId}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const checked = checkDialNumber(interaction.options.getString("to", true));
    if ("error" in checked) {
      await interaction.reply({ content: checked.error, flags: MessageFlags.Ephemeral });
      return;
    }
    await this.dialHandler(interaction, checked.number);
  }

  private async sendSms(interaction: ChatInputCommandInteraction): Promise<void> {
    // Access control: only members of the (private) SMS channel may send.
    if (interaction.channelId !== this.channelId) {
      await interaction.reply({ content: `Use this command in <#${this.channelId}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const to = interaction.options.getString("to", true).replace(/[\s-]/g, "");
    const text = interaction.options.getString("text", true);
    if (!PHONE_NUMBER.test(to)) {
      await interaction.reply({ content: `Invalid phone number: \`${to}\``, flags: MessageFlags.Ephemeral });
      return;
    }
    const [modem] = await this.mm.modems();
    if (!modem) {
      await interaction.reply({ content: "No modem found.", flags: MessageFlags.Ephemeral });
      return;
    }

    // Sending can take several seconds; the reply is public as an audit trail.
    await interaction.deferReply();
    const embed = new EmbedBuilder()
      .setTitle(`📤 SMS to ${to}`)
      .setDescription(text)
      .setFooter({ text: `Sent by ${interaction.user.tag} via ${modem.model}` })
      .setTimestamp(new Date());
    try {
      await this.mm.sendSms(modem.path, to, text);
      console.info(`${interaction.user.tag} sent SMS to ${to}`);
      await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (e) {
      const message = (e as Error).message;
      console.error(`SMS to ${to} failed: ${message}`);
      embed.setTitle(`❌ SMS to ${to} failed`).addFields({ name: "Error", value: message.slice(0, 1024) });
      await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }
}
