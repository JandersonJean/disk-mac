# Disk Mac

Aplicativo para macOS com interface em português. Reúne limpeza de arquivos, desinstalação de aplicativos e pacotes Homebrew, análise de disco, rotinas de otimização, backups e monitoramento do sistema.

Desenvolvido a partir do [mac-cleaner-cli de Gustavo Costa](https://github.com/guhcostan/mac-cleaner-cli), sob licença MIT. A CLI continua disponível no código deste repositório.

- **Monitor do sistema** com CPU, GPU, memória e rede a cada 500 ms enquanto visível, lista de processos e painel na barra de menus.
- **Limpeza e backup** com revisão dos itens e restauração de cópias compatíveis.
- **Análise de disco** com mapa de uso, navegação por pastas e envio à Lixeira após revisão.

No macOS, use Node.js 22.18+ ou 24.11+ e Bun para executar a partir do código.

```bash
git clone https://github.com/JandersonJean/disk-mac.git
cd disk-mac
bun install --frozen-lockfile
cd desktop
bun install --frozen-lockfile
bun run start
```

Veja os [detalhes do desktop](desktop/README.md), os [releases do Disk Mac](https://github.com/JandersonJean/disk-mac/releases) e o [estado do projeto](AGENTS.md).

---

## ⚡ Quick Start

```bash
bun run dev
```

With the root project's dependencies installed, the CLI will:

1. 🔍 **Scan** your Mac for cleanable files
2. 📋 **Show** you what was found with sizes
3. ✅ **Let you select** exactly what to clean
4. 🗑️ **Clean** only what you chose

## 🖥️ Desktop App (menu bar) — new

Prefer not to open a terminal? **Disk Mac** is a menu bar app built on the same scanners as the CLI.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/app-dark.png">
    <img src="assets/screenshots/app-light.png" alt="Disk Mac menu bar app: space freed, disk usage, last run and next automatic clean" width="620">
  </picture>
</p>

- 🧹 **Cleans automatically every day** at the time you pick (temp files, browser cache, logs — you choose). If your Mac was asleep, it catches up when it wakes.
- ⚡ **Clean Now** from the menu bar whenever you want
- 🔥 **Deep Clean (hard delete)** — scan many more places, review the biggest items per category and permanently delete only what you tick, after a confirmation
- 📊 **History** of every run with the space freed per category, plus a notification after each automatic clean
- 🛡️ Risky categories are never cleaned unattended, and recently used temp files are left alone

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/app-tour-dark.png">
    <img src="assets/screenshots/app-tour-light.png" alt="Deep Clean asking to confirm a hard delete, the History of runs, and the Settings with the daily schedule" width="100%">
  </picture>
</p>

The fork's installers use [Disk Mac Releases](https://github.com/JandersonJean/disk-mac/releases) after matching archives are published. To run the app from source, follow the build instructions above.

## 🎬 The CLI In Action

<p align="center">
  <img src="assets/demo.gif" alt="mac-cleaner-cli demo" width="100%">
</p>

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🚀 **One Command** | Just run `bun run dev`  after installing the project dependencies |
| 🎯 **Interactive** | Select exactly what you want to clean with checkboxes |
| 📁 **File Explorer** | Drill down (`→`) into categories to select specific folders/files |
| 🛡️ **Safe by Default** | Risky items hidden unless you use `--risky` |
| 👀 **Dry Run** | Preview exactly what would be deleted with `--dry-run` |
| ♻️ **Optional Backups** | Move items to a backup folder instead of deleting, restore later |
| 🤖 **Scriptable** | `scan --json` and `clean --categories … --yes` for cron and CI |
| 🖥️ **Menu Bar App** | Daily automatic cleaning, Deep Clean and history — `bun run dev app install` |
| 🔍 **Smart Scanning** | Finds caches, logs, dev files, browser data, and more |
| 📱 **App Uninstaller** | Remove apps completely with all associated files |
| 🔧 **Maintenance** | Flush DNS cache, free purgeable space |
| 🔒 **Privacy First** | 100% offline — no data ever leaves your machine |
| 📦 **Minimal Dependencies** | Only 5 runtime deps, all from trusted maintainers |

## 💰 vs. Paid Alternatives

| | Mac Cleaner CLI | CleanMyMac X | DaisyDisk |
|---|---|---|---|
| **Price** | **Free** | $39.95/year | $9.99 one-time |
| **Open Source** | ✅ | ❌ | ❌ |
| **Telemetry / Analytics** | ❌ None | ⚠️ Yes | ⚠️ Yes |
| **Works via terminal** | ✅ | ❌ | ❌ |
| **Menu bar app** | ✅ | ✅ | ❌ |
| **Automatic daily cleaning** | ✅ | ✅ | ❌ |
| **CI/CD friendly** | ✅ | ❌ | ❌ |
| **Customizable** | ✅ Fork it | ❌ | ❌ |
| **App Uninstaller** | ✅ | ✅ | ❌ |
| **File-level selection** | ✅ | ✅ | ✅ |

## 🎯 What It Cleans

### 🟢 Safe (always safe to delete)

| Category | What it cleans |
|----------|---------------|
| `trash` | Files in the Trash bin |
| `temp-files` | Temporary files in /tmp and /var/folders |
| `browser-cache` | Chrome, Safari, Firefox, Arc cache |

### 🟡 Moderate (generally safe)

| Category | What it cleans |
|----------|---------------|
| `system-cache` | Application caches in ~/Library/Caches |
| `system-logs` | System and application logs |
| `dev-cache` | npm, yarn, pip, Xcode DerivedData, CocoaPods |
| `node-modules` | Orphaned node_modules in old projects |
| `homebrew` | Homebrew download cache **and old formula versions** (`brew cleanup --prune=all`) |
| `docker` | Unused images, stopped containers, build cache — **only the types you select** |

> `docker` and `homebrew` are **not** "safe": their cleanup is performed by the
> external tool, and it removes more than downloaded files. Docker removes images
> that aren't used by a *running* container (they must be pulled or rebuilt
> again), and Homebrew removes old formula versions. Docker **volumes are never
> touched** — that's your data, not cache.

### 🔴 Risky (use `--risky` flag)

| Category | What it cleans |
|----------|---------------|
| `downloads` | Downloads older than 30 days |
| `ios-backups` | iPhone and iPad backup files |
| `mail-attachments` | Downloaded email attachments |
| `duplicates` | Duplicate files (keeps newest) |
| `large-files` | Files larger than 500MB |
| `language-files` | Unused language localizations — **breaks the app's code signature** |
| `git-worktrees` | Stale or orphaned git worktrees (agents, feature checkouts) |

## 📖 Usage

### Basic Usage

```bash
# Interactive mode — scan, select, and clean
bun run dev

# Include risky categories
bun run dev --risky

# Preview what would be deleted, without deleting anything
bun run dev --dry-run

# Enable file picker for all categories
bun run dev --risky -f
```

### Folder-Level Selection (Interactive)

In interactive mode, press `→` on supported categories to drill into specific folders/files:

- `↑↓` navigate • `←` back • `→` enter • `space` select • `a` all • `i` invert • `⏎` submit

Supported categories: User Cache Files, Temporary Files, System Log Files, Development Cache, Browser Cache, Homebrew Cache.

### Scripting & Automation (non-interactive)

```bash
# Scan only — see what can be cleaned without deleting anything
bun run dev scan

# Machine-readable output for scripts and integrations
bun run dev scan --json
bun run dev scan --json --verbose   # include item paths

# Clean specific categories without prompts (great for cron/CI)
bun run dev clean --categories trash,browser-cache,homebrew --yes

# Preview first
bun run dev clean --categories dev-cache --dry-run

# Clean everything that is safe, no selection UI
bun run dev clean --all --yes
```

Risky categories (downloads, iOS backups, etc) are always skipped unless you pass `--unsafe`.

### Uninstall Apps

Remove applications completely with all their preferences, caches, and support files:

```bash
bun run dev uninstall
```

### Maintenance Tasks

```bash
# Flush DNS cache (may require sudo)
bun run dev maintenance --dns

# Free purgeable space
bun run dev maintenance --purgeable

# Delete Time Machine local snapshots (requires sudo, asks for confirmation)
sudo bun run dev maintenance --timemachine

# Preview it first, or skip the prompt
bun run dev maintenance --timemachine --dry-run
sudo bun run dev maintenance --timemachine --yes
```

Local snapshots are taken automatically by Time Machine and can grow to hundreds of gigabytes.
Deleting them is irreversible — they are your only local rollback point while the backup disk is
disconnected — but macOS recreates them as needed once it is reconnected.

### Other Commands

```bash
# List all available categories
bun run dev categories

# Manage configuration
bun run dev config --init
bun run dev config --show

# Manage backups
bun run dev backup --list
bun run dev backup --restore <dir>
bun run dev backup --clean

# Install or update the menu bar app (--no-open, --dir <folder>)
bun run dev app install
```

### Backups (opt-in)

By default, cleaning is **permanent**: files are removed with `rm -rf` and do
**not** go to the Trash.

You can opt into backups by setting `backupEnabled` in `~/.maccleanerrc`:

```json
{ "backupEnabled": true }
```

With backups on, selected items are **moved** to `~/.mac-cleaner-cli/backup/<timestamp>/`
instead of being deleted, and can be brought back with `backup --restore`.

Two honest caveats:

- **Moving does not free disk space.** The files still occupy the same volume.
  Space is only reclaimed by `backup --clean`, which deletes backups older than
  7 days permanently.
- **Docker and Homebrew cannot be backed up.** Their cleanup is performed by the
  external tool (`docker system prune`, `brew cleanup`), so there is no file for
  us to move. The CLI warns you before proceeding when these are selected.

If a backup fails, the item is **not** deleted — it stays where it is and the
failure is reported.

### Flags

```bash
-V, --version          Show version number
-h, --help             Show help
-r, --risky            Include risky categories
-d, --dry-run          Show what would be deleted, delete nothing
-f, --file-picker      Force file picker for ALL categories
-A, --absolute-paths   Show absolute paths
    --no-progress      Disable progress bars
```

### Troubleshooting

Scans tolerate unreadable paths (missing Full Disk Access, permission errors), so a
category can come back empty without an obvious reason. Set `MAC_CLEANER_DEBUG=1` to
print every skipped path and the underlying error:

```bash
MAC_CLEANER_DEBUG=1 bun run dev scan
```

Exit codes: `0` on success, `1` when a category could not be scanned or an item could
not be deleted. `scan --json` also reports failures in an `errors` array.

## 🔒 Security

| | |
|---|---|
| ✅ **Open Source** | All code publicly available for audit |
| **Local operations** | Scans and monitoring run locally. Release installers contact GitHub. |
| **Permissions** | Most operations run as the current user. Some maintenance routines ask for macOS authorization. |
| ✅ **Minimal Deps** | Only 5 runtime dependencies |
| **CI** | GitHub Actions runs TypeScript, ESLint and automated tests |
| ✅ **Socket.dev** | Dependencies monitored for supply chain attacks |

Found a vulnerability? Report it via [GitHub Security Advisories](https://github.com/JandersonJean/disk-mac/security/advisories/new).

## 🛠️ Development

```bash
git clone https://github.com/JandersonJean/disk-mac.git
cd disk-mac
bun install
bun run dev      # Run in dev mode
bun run test     # Run tests
bun run lint     # Run linter
bun run build    # Build for production
```

Desktop app (Electron, lives in [`desktop/`](desktop/README.md)):

```bash
cd desktop
bun install
bun run start    # Build and launch the menu bar app
bun run test     # Run desktop tests
bun run dist     # Package .dmg/.zip into desktop/release (macOS only)
bun run screenshots  # Regenerate the README screenshots with sample data (needs Playwright)
```

## 🤝 Contributing

Contributions are very welcome! Whether it's a new scanner, a bug fix, or a documentation improvement — we'd love your help.

**Read the full guide:** [CONTRIBUTING.md](CONTRIBUTING.md)

Quick steps:
1. Fork the repo
2. Create your branch: `git checkout -b feat/my-feature`
3. Make your changes and add tests
4. Run `bun run lint && bun run test`
5. Open a Pull Request

Looking for a place to start? Check issues labeled [`good first issue`](https://github.com/JandersonJean/disk-mac/labels/good%20first%20issue) or [`help wanted`](https://github.com/JandersonJean/disk-mac/labels/help%20wanted).

## 💬 Community

- [GitHub Discussions](https://github.com/JandersonJean/disk-mac/discussions) — questions, ideas, show & tell
- [Issues](https://github.com/JandersonJean/disk-mac/issues) — bug reports and feature requests

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <strong>⚠️ Disclaimer</strong><br>
  This tool deletes files from your system. While we've implemented safety measures, always ensure you have backups of important data.
</p>

<p align="center">
  Made with ❤️ for Mac users everywhere
</p>
