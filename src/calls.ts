import {
  ActionRowBuilder, ButtonBuilder, type ButtonInteraction, ButtonStyle, EmbedBuilder,
  type Message, MessageFlags, type SendableChannels, type VoiceBasedChannel,
} from "discord.js";
import { CallBridge } from "./bridge.ts";
import type { Phone } from "./phone.ts";

const BUTTON_ANSWER = "call:answer";
const BUTTON_DECLINE = "call:decline";
const BUTTON_HANGUP = "call:hangup";
export const CALL_BUTTONS = [BUTTON_ANSWER, BUTTON_DECLINE, BUTTON_HANGUP];

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
 * buttons, bridges an answered call into the voice channel, and keeps the
 * message up to date until the call ends.
 */
export class CallController {
  private phone: Phone;
  private textChannel: SendableChannels;
  private voiceChannel: VoiceBasedChannel;
  private audioPortPath: string;
  private message: Message | undefined;
  private bridge: CallBridge | undefined;
  private answeredBy = "";

  constructor(phone: Phone, textChannel: SendableChannels, voiceChannel: VoiceBasedChannel, audioPortPath: string) {
    this.phone = phone;
    this.textChannel = textChannel;
    this.voiceChannel = voiceChannel;
    this.audioPortPath = audioPortPath;
    phone.on("incoming", (number) => void this.onIncoming(number).catch(logError("incoming")));
    phone.on("ended", (info) => void this.onEnded(info).catch(logError("ended")));
  }

  private embed(title: string, color: number, description?: string): EmbedBuilder {
    const e = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp(new Date());
    if (description) e.setDescription(description);
    return e;
  }

  private caller(): string {
    return this.phone.number || "unknown number";
  }

  /**
   * Shows who the bot is relaying in the voice channel by renaming it for
   * the duration of the call (null restores the default name). Needs the
   * Change Nickname permission; failure only costs the cosmetic.
   */
  private async setNickname(nickname: string | null): Promise<void> {
    try {
      await this.voiceChannel.guild.members.me?.setNickname(nickname);
    } catch (e) {
      console.warn(`could not set nickname: ${(e as Error).message}`);
    }
  }

  private async onIncoming(number: string): Promise<void> {
    console.info(`incoming call from ${number || "unknown"}`);
    this.answeredBy = "";
    this.message = await this.textChannel.send({
      embeds: [this.embed(`📞 Incoming call from ${this.caller()}`, 0xf1c40f)],
      components: [buttons(
        [BUTTON_ANSWER, "Answer", ButtonStyle.Success],
        [BUTTON_DECLINE, "Decline", ButtonStyle.Danger],
      )],
      allowedMentions: { parse: [] },
    });
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
        await interaction.update({
          embeds: [this.embed(`📞 Answering call from ${this.caller()}…`, 0x3498db, `Answered by ${user}`)],
          components: [],
        });
        this.answeredBy = user;
        await this.answer();
        return;
      }
      case BUTTON_DECLINE:
        await interaction.deferUpdate();
        console.info(`call declined by ${interaction.user.tag}`);
        this.answeredBy = "";
        await this.message.edit({
          embeds: [this.embed(`📵 Declined call from ${this.caller()}`, 0x95a5a6, `Declined by ${user}`)],
          components: [],
        });
        this.message = undefined;
        await this.phone.hangup();
        return;
      case BUTTON_HANGUP:
        await interaction.deferUpdate();
        console.info(`call hung up by ${interaction.user.tag}`);
        await this.phone.hangup();
        return;
    }
  }

  private async answer(): Promise<void> {
    try {
      await this.phone.answer();
      await this.phone.enableUsbAudio();
      await this.setNickname(`📞 ${this.caller()}`.slice(0, 32));
      const bridge = new CallBridge(this.audioPortPath, this.voiceChannel);
      this.bridge = bridge;
      await bridge.start();
      // The caller may have hung up while we were connecting.
      if (this.phone.state !== "active") {
        if (this.bridge === bridge) this.bridge = undefined;
        await bridge.stop();
        return;
      }
    } catch (e) {
      if (this.phone.state === "idle") return; // call ended meanwhile; onEnded handled it
      console.error(`answering failed: ${(e as Error).message}`);
      await this.message?.edit({
        embeds: [this.embed(`⚠️ Call from ${this.caller()} failed`, 0xe74c3c, (e as Error).message)],
        components: [],
      });
      this.message = undefined;
      await this.phone.hangup().catch(() => {});
      return;
    }
    console.info(`call from ${this.phone.number} bridged to #${this.voiceChannel.name}`);
    await this.message?.edit({
      embeds: [this.embed(
        `🟢 In call with ${this.caller()}`, 0x2ecc71,
        `Answered by ${this.answeredBy}\nJoin ${this.voiceChannel} to talk.`,
      )],
      components: [buttons([BUTTON_HANGUP, "Hang up", ButtonStyle.Danger])],
    });
  }

  private async onEnded({ answered, durationSec }: { answered: boolean; durationSec: number }): Promise<void> {
    console.info(`call ended (answered: ${answered}, ${durationSec}s)`);
    const bridge = this.bridge;
    this.bridge = undefined;
    await bridge?.stop();
    if (answered) await this.setNickname(null);

    const message = this.message;
    this.message = undefined;
    if (!message) return; // declined or failed: already updated
    const embed = answered
      ? this.embed(`☎️ Call with ${this.caller()} ended`, 0x95a5a6,
        `Answered by ${this.answeredBy} · ${formatDuration(durationSec)}`)
      : this.embed(`❗ Missed call from ${this.caller()}`, 0xe74c3c);
    await message.edit({ embeds: [embed], components: [] });
  }

  async shutdown(): Promise<void> {
    await this.bridge?.stop();
    await this.phone.hangup().catch(() => {});
  }
}

function logError(what: string) {
  return (e: unknown) => console.error(`call ${what} handling failed: ${(e as Error).message}`);
}
