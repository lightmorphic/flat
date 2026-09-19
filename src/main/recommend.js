'use strict';

// Which apps arrive already ticked.
//
// The rule: a backup is worth making because of profiles,
// logins, notes and project files. An image converter's empty config folder
// is not worth forty gigabytes of anybody's time. So the list below is an
// allow-list of things known to keep something, plus a size floor for
// everything else.

// Matched against the app id, case-insensitively, as a substring. Ids are
// reverse-DNS, so `firefox` catches org.mozilla.firefox and
// io.gitlab.librewolf-community alike without listing every fork.
const KEEPS_A_PROFILE = [
  // Browsers
  'firefox', 'librewolf', 'chromium', 'chrome', 'brave', 'vivaldi', 'opera',
  'zen-browser', 'zen.browser', 'floorp', 'waterfox', 'tor.browser', 'torbrowser',
  'epiphany', 'falkon', 'midori', 'min.browser',
  // Email
  'thunderbird', 'betterbird', 'geary', 'evolution', 'mailspring', 'bluemail',
  // Chat and calls
  'element', 'signal', 'discord', 'telegram', 'whatsapp', 'slack', 'zoom',
  'fractal', 'dino', 'gajim', 'revolt', 'ferdium', 'rocketchat', 'mattermost',
  'threema', 'session', 'wire',
  // Notes, PKM, writing
  'obsidian', 'joplin', 'logseq', 'zettlr', 'standardnotes', 'anytype',
  'trilium', 'notesnook', 'zotero', 'calibre', 'gnome.Notes', 'marktext',
  // Password managers
  'bitwarden', 'keepassxc', 'keeweb', 'proton.pass', 'enpass', '1password',
  // Media tools with project files
  'audacity', 'kdenlive', 'obsproject', 'obs-studio', 'ardour', 'lmms',
  'shotcut', 'openshot', 'blender', 'darktable', 'rawtherapee', 'krita',
  'inkscape', 'gimp', 'musescore', 'tenacity', 'olive',
  // Finance, clients, sync
  'gnucash', 'homebank', 'nextcloud', 'syncthing', 'rclone', 'remmina',
  'filezilla', 'thunderbird', 'dbeaver', 'beekeeper',
  // Game launchers keep libraries and logins
  'steam', 'lutris', 'heroic', 'bottles', 'prismlauncher',
];

// Anything on this list is left unticked even if it clears the size floor:
// these are the apps whose directory is large but replaceable.
const NOT_WORTH_MOVING = [
  'ffmpeg', 'handbrake', 'losslesscut', 'imagemagick', 'converseen',
  'gnome.Calculator', 'kcalc', 'galculator', 'qalculate',
  'eog', 'loupe', 'gwenview', 'nomacs', 'shotwell.viewer',
  'evince', 'papers', 'okular', 'xreader', 'zathura',
  'gnome.Characters', 'gnome.Weather', 'gnome.Clocks', 'gnome.Maps',
  'baobab', 'gnome.DiskUtility', 'gnome.Logs', 'gnome.SystemMonitor',
  'flatseal', 'warehouse', 'gearlever', 'mission.center',
];

// Five megabytes. Below this an app has a settings file and nothing else,
// and restoring it saves nobody anything.
const SIZE_FLOOR = 5 * 1024 * 1024;

function matches(id, list) {
  const lower = id.toLowerCase();
  return list.some((needle) => lower.includes(needle.toLowerCase()));
}

// `reason` is shown in the row's tooltip so the tick is never a mystery.
function recommend(app) {
  if (!app.hasData) {
    return { recommended: false, reason: 'No data directory to back up' };
  }
  if (matches(app.id, NOT_WORTH_MOVING)) {
    return { recommended: false, reason: 'Nothing here that cannot be recreated' };
  }
  if (matches(app.id, KEEPS_A_PROFILE)) {
    return { recommended: true, reason: 'Keeps a profile, logins or project files' };
  }
  if (app.dataBytes >= SIZE_FLOOR) {
    return { recommended: true, reason: 'Has a data directory worth keeping' };
  }
  return { recommended: false, reason: 'Under 5 MB and no known profile' };
}

module.exports = { recommend, SIZE_FLOOR, KEEPS_A_PROFILE, NOT_WORTH_MOVING };
