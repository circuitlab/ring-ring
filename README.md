# ring-ring

A Discord bot for the SIM-equipped modem on this server.

- Forwards SMS received by ModemManager to a Discord channel
- `/status` shows the modem's operator, network, signal and SMS count
- `/sms to text` sends an SMS. It only works in the configured channel, which
  is private, so channel membership is the access control. The result is
  posted publicly in the channel as an audit trail.

Planned: bridging phone calls to a voice channel.

## How it works

- Target hardware: SIMCOM SIM7600G-H, managed by ModemManager (QMI); the bot
  talks to ModemManager over the system D-Bus
- Written in TypeScript and run directly by Node.js (type stripping, no build)
- New SMS are picked up immediately via D-Bus signals; a rescan every
  60 seconds catches anything that was missed
- Forwarded messages are recorded in `/var/lib/ring-ring/seen.json`, so a
  restart never sends duplicates
- On the very first start, messages already on the modem are marked as seen
  instead of being forwarded (set `FORWARD_EXISTING=1` to forward them)

## Discord setup

1. Create an application at https://discord.com/developers/applications
2. Bot tab: Reset Token and put it in `DISCORD_TOKEN`. No privileged intents
   are needed.
3. OAuth2 > URL Generator: scopes `bot` and `applications.commands`;
   permissions View Channel, Send Messages, Embed Links. Open the URL to
   invite the bot.

## Installation

As a user with sudo rights (circuitlab):

```sh
sudo sh deploy/install.sh     # from a checkout of this repository
sudo systemctl enable --now ring-ring
journalctl -u ring-ring -f
```

`install.sh` installs a pinned Node.js under `/opt/ring-ring/node` (the
distribution's Node is too old for `@discordjs/voice`), the app and its
dependencies under `/opt/ring-ring`, the systemd unit and a polkit rule.

The service config is `/etc/ring-ring/ring-ring.env`. If `deploy/ring-ring.env`
exists (git-ignored, holds the bot token), `install.sh` installs it there;
otherwise it installs `deploy/ring-ring.env.example` for you to edit.

After changing the code or config, run `install.sh` again to deploy and restart.

## SIM storage

SMS are stored on the SIM, which has little room; once it is full, new SMS
can no longer be received. `DELETE_AFTER_FORWARD=1` (the default) deletes
messages after they are forwarded, as well as the ones marked as seen on the
first start. `install.sh` installs the polkit rule that allows this.

## Development

```sh
npm install
npm run check        # type check
DISCORD_TOKEN=... DISCORD_CHANNEL_ID=... STATE_DIR=./state npm start
```

Deleting and sending SMS need the polkit permission, which only the service
user has.
