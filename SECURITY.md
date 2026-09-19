# Security

## What Flat can touch

Flat runs as you, never as root, and asks for no elevated permissions.

- It reads the list of installed Flatpak apps and, for the apps you pick,
  their data folders under `~/.var/app` and their permission overrides.
- It writes a backup file only where you choose to save it.
- On a restore or an install it adds Flatpak remotes, installs apps and
  writes app data, all at **user scope** (`--user`). It never installs
  system-wide and never runs `sudo` or `pkexec`.
- It hands everything to the `flatpak` and `tar` commands. App IDs and
  remote names are checked against a strict pattern before they are passed
  to either, so a hand-edited list file cannot smuggle in extra arguments.

When a remote exists only system-wide, Flat adds its own user-scope copy
and imports the system installation's trusted signing key with it, so
signature checking stays on. It never adds a remote with verification
turned off.

## What a backup file contains

A `.fmpack` holds the full contents of each chosen app's data folder. For a
browser that includes cookies, history and saved passwords. **It is not
encrypted.** Treat it with the same care as the machine it came from.

Each app inside a backup carries a SHA-256 checksum, checked before its data
is unpacked, so a damaged or altered file is refused rather than restored.

## Network

Flat checks for a newer version of itself when it starts and every thirty
minutes, and downloads one only when you click. Searching for and installing
apps is Flatpak talking to Flathub, or to the remote you chose.

The renderer runs with context isolation, no Node integration and a strict
Content Security Policy, and every link that would open a web page is handed
to your own browser instead of loading inside the app.

## Reporting a problem

Please report security issues privately to
[security@lightmorphic.com](mailto:security@lightmorphic.com) rather than in a
public issue. We aim to reply within five working days.
