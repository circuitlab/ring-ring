import {
  ActionRowBuilder, ButtonBuilder, type ButtonInteraction, ButtonStyle, type ChatInputCommandInteraction,
  EmbedBuilder, type Message, MessageFlags, Routes, type SendableChannels, type VoiceBasedChannel,
} from "discord.js";
import { CallBridge } from "./bridge.ts";
import type { EndInfo, Phone } from "./phone.ts";

const BUTTON_ANSWER = "call:answer";
const BUTTON_DECLINE = "call:decline";
const BUTTON_HANGUP = "call:hangup";

/**
 * Outgoing calls are limited to domestic Japanese numbers (0 + 9-10 digits,
 * optionally prefixed with 184/186 to hide/show caller ID). This rules out
 * emergency and other 1xx short codes and international calls.
 */
const DIALABLE = /^(?:184|186)?0[1-9]\d{8,9}$/;
const INTERNATIONAL = /^(?:184|186)?(?:\+|00|010)/;

/** Returns the normalized number, or an error message for the user. */
export function checkDialNumber(input: string): { number: string } | { error: string } {
  const number = input.replace(/[\s()-]/g, "");
  if (INTERNATIONAL.test(number)) return { error: "International calls are not allowed." };
  if (!DIALABLE.test(number)) {
    return { error: `\`${number}\` is not a dialable domestic number (emergency and short codes are blocked).` };
  }
  return { number };
}

function buttons(...specs: Array<[id: string, label: string, style: ButtonStyle]>) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    specs.map(([id, label, style]) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style)),
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Glues the phone to Discord: posts incoming calls with Answer/Decline
 * buttons, places outgoing calls for /call, bridges connected calls into the
 * voice channel, and keeps the message up to date until the call ends.
 */
export class CallController {
  private phone: Phone;
  private textChannel: SendableChannels;
  private voiceChannel: VoiceBasedChannel;
  private audioPortPath: string;
  private message: Message | undefined;
  private bridge: CallBridge | undefined;
  private direction: "in" | "out" = "in";
  /** Mention of whoever answered (incoming) or placed (outgoing) the call. */
  private by = "";
  private cancelled = false;

  constructor(phone: Phone, textChannel: SendableChannels, voiceChannel: VoiceBasedChannel, audioPortPath: string) {
    this.phone = phone;
    this.textChannel = textChannel;
    this.voiceChannel = voiceChannel;
    this.audioPortPath = audioPortPath;
    phone.on("incoming", (number) => void this.onIncoming(number).catch(logError("incoming")));
    phone.on("answered", () => {
      // Incoming calls connect from answer(); outgoing ones when the callee picks up.
      if (this.direction === "out") void this.connect().catch(logError("connect"));
    });
    phone.on("ended", (info) => void this.onEnded(info).catch(logError("ended")));
  }

  private embed(title: string, color: number, description?: string): EmbedBuilder {
    const e = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp(new Date());
    if (description) e.setDescription(description);
    return e;
  }

  private peer(): string {
    return this.phone.number || "unknown number";
  }

  private byLine(): string {
    return `${this.direction === "in" ? "Answered" : "Called"} by ${this.by}`;
  }

  /**
   * Sets the voice channel's status line ("" clears it). Without Manage
   * Channels the bot may only do this while connected to the channel.
   * Failure only costs the cosmetic.
   */
  private async setVoiceStatus(status: string): Promise<void> {
    try {
      await this.voiceChannel.client.rest.put(Routes.channelVoiceStatus(this.voiceChannel.id), { body: { status } });
    } catch (e) {
      console.warn(`could not set voice channel status: ${(e as Error).message}`);
    }
  }

  private async onIncoming(number: string): Promise<void> {
    console.info(`incoming call from ${number || "unknown"}`);
    this.direction = "in";
    this.by = "";
    this.message = await this.textChannel.send({
      embeds: [this.embed(`📞 Incoming call from ${this.peer()}`, 0xf1c40f)],
      components: [buttons(
        [BUTTON_ANSWER, "Answer", ButtonStyle.Success],
        [BUTTON_DECLINE, "Decline", ButtonStyle.Danger],
      )],
      allowedMentions: { parse: [] },
    });
  }

  /** Handles /call: places an outgoing call and posts its progress as the reply. */
  async dial(interaction: ChatInputCommandInteraction, number: string): Promise<void> {
    if (this.phone.state !== "idle") {
      await interaction.reply({ content: "The line is busy.", flags: MessageFlags.Ephemeral });
      return;
    }
    this.direction = "out";
    this.by = interaction.user.toString();
    this.cancelled = false;
    const response = await interaction.reply({
      embeds: [this.embed(`📞 Calling ${number}…`, 0x3498db, `Called by ${this.by}`)],
      components: [buttons([BUTTON_HANGUP, "Cancel", ButtonStyle.Danger])],
      allowedMentions: { parse: [] },
      withResponse: true,
    });
    this.message = response.resource?.message ?? undefined;
    console.info(`${interaction.user.tag} is calling ${number}`);
    try {
      await this.phone.dial(number);
    } catch (e) {
      console.error(`dialing ${number} failed: ${(e as Error).message}`);
      await this.fail(e as Error);
    }
  }

  async onButton(interaction: ButtonInteraction): Promise<void> {
    if (!this.message || interaction.message.id !== this.message.id) {
      await interaction.reply({ content: "This call is no longer active.", flags: MessageFlags.Ephemeral });
      return;
    }
    const user = interaction.user.toString();
    switch (interaction.customId) {
      case BUTTON_ANSWER: {
        if (this.phone.state !== "ringing") {
          await interaction.reply({ content: "The call is not ringing any more.", flags: MessageFlags.Ephemeral });
          return;
        }
        this.by = user;
        await interaction.update({
          embeds: [this.embed(`📞 Answering call from ${this.peer()}…`, 0x3498db, this.byLine())],
          components: [],
        });
        await this.answer();
        return;
      }
      case BUTTON_DECLINE:
        await interaction.deferUpdate();
        console.info(`call declined by ${interaction.user.tag}`);
        await this.message.edit({
          embeds: [this.embed(`📵 Declined call from ${this.peer()}`, 0x95a5a6, `Declined by ${user}`)],
          components: [],
        });
        this.message = undefined;
        await this.phone.hangup();
        return;
      case BUTTON_HANGUP:
        await interaction.deferUpdate();
        console.info(`call hung up by ${interaction.user.tag}`);
        if (this.phone.state === "dialing") this.cancelled = true;
        await this.phone.hangup();
        return;
    }
  }

  private async answer(): Promise<void> {
    try {
      await this.phone.answer();
    } catch (e) {
      if (this.phone.state === "idle") return; // call ended meanwhile; onEnded handled it
      console.error(`answering failed: ${(e as Error).message}`);
      await this.fail(e as Error);
      return;
    }
    await this.connect();
  }

  /** Bridges the now-active call into the voice channel. */
  private async connect(): Promise<void> {
    try {
      await this.phone.enableUsbAudio();
      const bridge = new CallBridge(this.audioPortPath, this.voiceChannel);
      this.bridge = bridge;
      await bridge.start();
      // The other side may have hung up while we were connecting.
      if (this.phone.state !== "active") {
        if (this.bridge === bridge) this.bridge = undefined;
        await bridge.stop();
        return;
      }
      await this.setVoiceStatus(`📞 On call: ${this.peer()}`);
    } catch (e) {
      if (this.phone.state === "idle") return; // call ended meanwhile; onEnded handled it
      console.error(`connecting the call failed: ${(e as Error).message}`);
      await this.fail(e as Error);
      return;
    }
    console.info(`call with ${this.phone.number} bridged to #${this.voiceChannel.name}`);
    await this.message?.edit({
      embeds: [this.embed(
        `🟢 In call with ${this.peer()}`, 0x2ecc71,
        `${this.byLine()}\nJoin ${this.voiceChannel} to talk.`,
      )],
      components: [buttons([BUTTON_HANGUP, "Hang up", ButtonStyle.Danger])],
    });
  }

  /** Reports a failed call on its message and hangs up. */
  private async fail(e: Error): Promise<void> {
    const message = this.message;
    this.message = undefined;
    await message?.edit({
      embeds: [this.embed(`⚠️ Call with ${this.peer()} failed`, 0xe74c3c, e.message)],
      components: [],
    });
    await this.phone.hangup().catch(() => {});
  }

  private async onEnded({ answered, durationSec, reason }: EndInfo): Promise<void> {
    console.info(`call ended (${this.direction}, answered: ${answered}, ${durationSec}s, ${reason})`);
    const bridge = this.bridge;
    this.bridge = undefined;
    if (bridge) {
      await this.setVoiceStatus(""); // while still connected
      await bridge.stop();
    }

    const message = this.message;
    this.message = undefined;
    if (!message) return; // declined or failed: already updated
    let embed: EmbedBuilder;
    if (answered) {
      embed = this.embed(`☎️ Call with ${this.peer()} ended`, 0x95a5a6,
        `${this.byLine()} · ${formatDuration(durationSec)}`);
    } else if (this.direction === "in") {
      embed = this.embed(`❗ Missed call from ${this.peer()}`, 0xe74c3c);
    } else if (this.cancelled) {
      embed = this.embed(`📵 Call to ${this.peer()} cancelled`, 0x95a5a6, this.byLine());
    } else if (reason === "busy") {
      embed = this.embed(`📵 ${this.peer()} is busy`, 0xe67e22, this.byLine());
    } else {
      embed = this.embed(`📵 No answer from ${this.peer()}`, 0xe67e22, this.byLine());
    }
    await message.edit({ embeds: [embed], components: [] });
  }

  async shutdown(): Promise<void> {
    if (this.bridge) await this.setVoiceStatus("");
    await this.bridge?.stop();
    await this.phone.hangup().catch(() => {});
  }
}

function logError(what: string) {
  return (e: unknown) => console.error(`call ${what} handling failed: ${(e as Error).message}`);
}
