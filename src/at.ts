import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";

const FINAL = /^(OK|ERROR|\+CME ERROR:.*|\+CMS ERROR:.*)$/;
// Call setup failures end ATD/ATA; for any other command they are URCs.
const CALL_FINAL = /^(NO CARRIER|BUSY|NO ANSWER|NO DIALTONE)$/;
const CALL_COMMAND = /^AT[DA]/i;
// Unsolicited result codes that may arrive in the middle of a command.
const URC = /^(RING|MISSED_CALL:|VOICE CALL:|\+CMTI:|\+CLIP:|NO CARRIER|BUSY|NO ANSWER)/;
// Lines buffered before we opened the port (e.g. URCs from earlier calls) are stale.
const STALE_MS = 300;
const LOG_AT = process.env.LOG_AT === "1";

interface Pending {
  command: string;
  lines: string[];
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * AT command channel on one of the modem's serial ports.
 *
 * Commands are queued and resolved with their response lines. Lines that
 * arrive while no command is waiting are unsolicited result codes and are
 * emitted as "urc".
 */
export class AtPort extends EventEmitter {
  private port: SerialPort;
  private buffer = "";
  private queue: Array<() => void> = [];
  private pending: Pending | undefined;
  private discardUntil = 0;

  constructor(path: string) {
    super();
    this.port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
    this.port.on("data", (data: Buffer) => this.onData(data));
    this.port.on("error", (e) => this.emit("error", e));
    this.port.on("close", () => this.emit("close"));
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.port.open((e) => (e ? reject(e) : resolve())));
    this.discardUntil = Date.now() + STALE_MS;
    await new Promise<void>((resolve) => this.port.flush(() => resolve()));
    await new Promise((r) => setTimeout(r, STALE_MS));
    this.buffer = "";
  }

  close(): void {
    if (this.port.isOpen) this.port.close();
  }

  command(command: string, timeoutMs = 5000): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const run = () => {
        const timer = setTimeout(() => {
          this.pending = undefined;
          reject(new Error(`${command}: timed out`));
          this.next();
        }, timeoutMs);
        this.pending = { command, lines: [], resolve, reject, timer };
        if (LOG_AT) console.debug(`AT >> ${command}`);
        this.port.write(`${command}\r`);
      };
      this.queue.push(run);
      if (!this.pending && this.queue.length === 1) this.next();
    });
  }

  private next(): void {
    if (this.pending) return;
    this.queue.shift()?.();
  }

  private onData(data: Buffer): void {
    if (Date.now() < this.discardUntil) return;
    this.buffer += data.toString("latin1");
    let idx;
    while ((idx = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    if (LOG_AT) console.debug(`AT << ${line}`);
    const p = this.pending;
    // Echo of the command itself (if echo is on).
    if (p && line === p.command) return;
    if (!p) {
      this.emit("urc", line);
      return;
    }
    const callFinal = CALL_COMMAND.test(p.command) && CALL_FINAL.test(line);
    // URCs can interleave with a command's response; surface them anyway.
    // "VOICE CALL: BEGIN/END" is also part of the ATA/AT+CHUP response.
    if (URC.test(line) && !callFinal) {
      this.emit("urc", line);
      if (!line.startsWith("VOICE CALL:")) return;
    }
    p.lines.push(line);
    if (FINAL.test(line) || callFinal) {
      clearTimeout(p.timer);
      this.pending = undefined;
      if (line === "OK") p.resolve(p.lines.slice(0, -1));
      else p.reject(new Error(`${p.command}: ${p.lines.join(" | ")}`));
      this.next();
    }
  }
}
