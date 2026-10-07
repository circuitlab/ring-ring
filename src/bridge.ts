import { PassThrough } from "node:stream";
import {
  type AudioPlayer, createAudioPlayer, createAudioResource, EndBehaviorType, entersState,
  joinVoiceChannel, NoSubscriberBehavior, StreamType, type VoiceConnection, VoiceConnectionStatus,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import prism from "prism-media";
import { SerialPort } from "serialport";

// Modem side: 8 kHz 16-bit mono. Discord side: 48 kHz 16-bit stereo.
const RATIO = 6;
const MODEM_FRAME = 160;               // samples per 20 ms at 8 kHz
const DISCORD_FRAME = MODEM_FRAME * RATIO;
const MAX_QUEUE = 48000 * 0.3;         // per-speaker backlog cap (300 ms), to bound latency

/** 8 kHz mono → 48 kHz stereo with linear interpolation. Keeps the last sample between chunks. */
class Upsampler {
  private last = 0;
  private carry: Buffer = Buffer.alloc(0);

  process(chunk: Buffer): Buffer {
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const n = data.length >> 1;
    this.carry = data.subarray(n * 2);
    const out = Buffer.alloc(n * RATIO * 4);
    let o = 0;
    for (let i = 0; i < n; i++) {
      const cur = data.readInt16LE(i * 2);
      for (let k = 1; k <= RATIO; k++) {
        const v = Math.round(this.last + ((cur - this.last) * k) / RATIO);
        out.writeInt16LE(v, o);
        out.writeInt16LE(v, o + 2);
        o += 4;
      }
      this.last = cur;
    }
    return out;
  }
}

/** Buffers one speaker's decoded audio as 48 kHz mono samples. */
class SpeakerQueue {
  private samples: number[] = [];

  push(stereo: Buffer): void {
    for (let i = 0; i + 3 < stereo.length; i += 4) {
      this.samples.push((stereo.readInt16LE(i) + stereo.readInt16LE(i + 2)) / 2);
    }
    if (this.samples.length > MAX_QUEUE) this.samples.splice(0, this.samples.length - MAX_QUEUE);
  }

  take(n: number): number[] {
    return this.samples.splice(0, n);
  }
}

/**
 * Bridges a phone call (the modem's USB audio port) and a Discord voice channel.
 *
 * Phone → Discord: modem PCM is upsampled and played into the channel.
 * Discord → phone: every speaker is decoded, mixed, downsampled and written
 * to the modem at real-time pace (one 20 ms frame per tick).
 */
export class CallBridge {
  private audioPortPath: string;
  private channel: VoiceBasedChannel;
  private port: SerialPort | undefined;
  private connection: VoiceConnection | undefined;
  private player: AudioPlayer | undefined;
  private toDiscord = new PassThrough();
  private upsampler = new Upsampler();
  private speakers = new Map<string, SpeakerQueue>();
  private cleanups: Array<() => void> = [];
  private ticking = false;
  private stopped = false;

  constructor(audioPortPath: string, channel: VoiceBasedChannel) {
    this.audioPortPath = audioPortPath;
    this.channel = channel;
  }

  async start(): Promise<void> {
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    if (this.stopped) return;

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.player.on("error", (e) => console.warn(`voice player error: ${e.message}`));
    this.connection.subscribe(this.player);
    this.player.play(createAudioResource(this.toDiscord, { inputType: StreamType.Raw }));

    const botId = this.channel.client.user.id;
    const onSpeaking = (userId: string) => {
      if (userId !== botId && !this.speakers.has(userId)) this.listen(userId);
    };
    this.connection.receiver.speaking.on("start", onSpeaking);
    this.cleanups.push(() => this.connection?.receiver.speaking.off("start", onSpeaking));

    this.port = new SerialPort({ path: this.audioPortPath, baudRate: 115200, autoOpen: false });
    await new Promise<void>((resolve, reject) => this.port!.open((e) => (e ? reject(e) : resolve())));
    if (this.stopped) {
      this.port.close();
      return;
    }
    this.port.on("data", (chunk: Buffer) => this.toDiscord.write(this.upsampler.process(chunk)));
    this.port.on("error", (e) => console.warn(`audio port error: ${e.message}`));

    this.ticking = true;
    void this.tick();
  }

  private listen(userId: string): void {
    const queue = new SpeakerQueue();
    this.speakers.set(userId, queue);
    const opus = this.connection!.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opus.pipe(decoder);
    decoder.on("data", (pcm: Buffer) => queue.push(pcm));
    // A corrupt packet (e.g. during a DAVE key transition) must not kill the call.
    decoder.on("error", (e: Error) => console.debug(`decoder error for ${userId}: ${e.message}`));
    opus.on("error", (e: Error) => console.debug(`receive error for ${userId}: ${e.message}`));
    this.cleanups.push(() => {
      opus.destroy();
      decoder.destroy();
    });
  }

  /** Writes one mixed 20 ms frame to the modem per tick, correcting for timer drift. */
  private async tick(): Promise<void> {
    const start = performance.now();
    let frames = 0;
    const out = Buffer.alloc(MODEM_FRAME * 2);
    while (this.ticking) {
      const mix = new Float64Array(DISCORD_FRAME);
      for (const queue of this.speakers.values()) {
        const samples = queue.take(DISCORD_FRAME);
        for (let i = 0; i < samples.length; i++) mix[i] += samples[i];
      }
      for (let i = 0; i < MODEM_FRAME; i++) {
        let sum = 0;
        for (let k = 0; k < RATIO; k++) sum += mix[i * RATIO + k];
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / RATIO))), i * 2);
      }
      if (this.port?.isOpen) this.port.write(Buffer.from(out));
      frames++;
      const wait = start + frames * 20 - performance.now();
      await new Promise((r) => setTimeout(r, Math.max(0, wait)));
    }
  }

  /** Idempotent; also safe to call while start() is still in progress. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.ticking = false;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.speakers.clear();
    this.toDiscord.end();
    this.player?.stop(true);
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    if (this.port?.isOpen) await new Promise<void>((r) => this.port!.close(() => r()));
  }
}
