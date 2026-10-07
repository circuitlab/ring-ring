import { EventEmitter } from "node:events";
import dbus from "dbus-next";

const MM_BUS = "org.freedesktop.ModemManager1";
const MM_PATH = "/org/freedesktop/ModemManager1";
const IFACE_OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager";
const IFACE_PROPERTIES = "org.freedesktop.DBus.Properties";
const IFACE_MODEM = "org.freedesktop.ModemManager1.Modem";
const IFACE_3GPP = "org.freedesktop.ModemManager1.Modem.Modem3gpp";
const IFACE_MESSAGING = "org.freedesktop.ModemManager1.Modem.Messaging";
const IFACE_SMS = "org.freedesktop.ModemManager1.Sms";

// MMSmsState / MMSmsPduType
export const SMS_STATE_RECEIVING = 2;
export const SMS_STATE_RECEIVED = 3;
export const SMS_PDU_TYPE_SUBMIT = 2;
export const SMS_PDU_TYPE_STATUS_REPORT = 3;

// MMModemAccessTechnology bits
const ACCESS_TECH: Record<number, string> = {
  0x2: "GSM", 0x20: "UMTS", 0x40: "HSDPA", 0x80: "HSUPA", 0x100: "HSPA",
  0x200: "HSPA+", 0x4000: "LTE", 0x8000: "5G NR",
};

export interface Sms {
  path: string;
  number: string;
  text: string;
  data: Buffer;
  timestamp: string;
  state: number;
  pduType: number;
}

export interface ModemInfo {
  path: string;
  model: string;
  ownNumbers: string[];
  operator: string;
  accessTech: string;
  signalQuality: number;
  state: number;
  messages: string[];
}

type Props = Record<string, dbus.Variant>;

function unwrap(props: Props): Record<string, any> {
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.value]));
}

function accessTechName(bits: number): string {
  const names = Object.entries(ACCESS_TECH)
    .filter(([bit]) => bits & Number(bit))
    .map(([, name]) => name);
  return names.join("/") || "none";
}

/**
 * Thin wrapper around ModemManager's D-Bus API.
 *
 * Emits "changed" whenever something happened that may warrant a rescan
 * (new SMS, modem (re)appeared).
 */
export class ModemManager extends EventEmitter {
  private bus = dbus.systemBus();
  private watchedModems = new Set<string>();

  async start(): Promise<void> {
    const root = await this.bus.getProxyObject(MM_BUS, MM_PATH);
    const om = root.getInterface(IFACE_OBJECT_MANAGER);
    om.on("InterfacesAdded", (path: string) => {
      this.watchModem(path).catch(() => {});
      this.emit("changed");
    });
    om.on("InterfacesRemoved", (path: string) => this.watchedModems.delete(path));
    for (const modem of await this.modems()) await this.watchModem(modem.path);
  }

  private async watchModem(path: string): Promise<void> {
    if (this.watchedModems.has(path)) return;
    const obj = await this.bus.getProxyObject(MM_BUS, path);
    if (!obj.interfaces[IFACE_MESSAGING]) return;
    this.watchedModems.add(path);
    obj.getInterface(IFACE_MESSAGING).on("Added", () => this.emit("changed"));
  }

  async modems(): Promise<ModemInfo[]> {
    const root = await this.bus.getProxyObject(MM_BUS, MM_PATH);
    const objects: Record<string, Record<string, Props>> =
      await root.getInterface(IFACE_OBJECT_MANAGER).GetManagedObjects();
    const result: ModemInfo[] = [];
    for (const [path, ifaces] of Object.entries(objects)) {
      if (!ifaces[IFACE_MESSAGING]) continue;
      const modem = unwrap(ifaces[IFACE_MODEM] ?? {});
      const gpp = unwrap(ifaces[IFACE_3GPP] ?? {});
      const messaging = unwrap(ifaces[IFACE_MESSAGING]);
      result.push({
        path,
        model: modem.Model ?? "modem",
        ownNumbers: modem.OwnNumbers ?? [],
        operator: gpp.OperatorName ?? "",
        accessTech: accessTechName(modem.AccessTechnologies ?? 0),
        signalQuality: modem.SignalQuality?.[0] ?? 0,
        state: modem.State ?? 0,
        messages: messaging.Messages ?? [],
      });
    }
    return result;
  }

  async readSms(path: string): Promise<Sms> {
    const obj = await this.bus.getProxyObject(MM_BUS, path);
    const p = unwrap(await obj.getInterface(IFACE_PROPERTIES).GetAll(IFACE_SMS));
    return {
      path,
      number: p.Number ?? "",
      text: p.Text ?? "",
      data: Buffer.from(p.Data ?? []),
      timestamp: p.Timestamp ?? "",
      state: p.State ?? 0,
      pduType: p.PduType ?? 0,
    };
  }

  /** Sends an SMS; ModemManager splits long texts into multipart messages. */
  async sendSms(modemPath: string, number: string, text: string): Promise<void> {
    const modem = await this.bus.getProxyObject(MM_BUS, modemPath);
    const messaging = modem.getInterface(IFACE_MESSAGING);
    const smsPath: string = await messaging.Create({
      number: new dbus.Variant("s", number),
      text: new dbus.Variant("s", text),
    });
    try {
      const sms = await this.bus.getProxyObject(MM_BUS, smsPath);
      await sms.getInterface(IFACE_SMS).Send();
    } finally {
      // The outgoing SMS object is not needed once sent (or failed).
      await messaging.Delete(smsPath).catch(() => {});
    }
  }

  async deleteSms(modemPath: string, smsPath: string): Promise<void> {
    const obj = await this.bus.getProxyObject(MM_BUS, modemPath);
    await obj.getInterface(IFACE_MESSAGING).Delete(smsPath);
  }

  disconnect(): void {
    this.bus.disconnect();
  }
}
