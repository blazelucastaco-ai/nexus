#!/usr/bin/env tsx
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import chalk from "chalk";
import gradient from "gradient-string";
import boxen from "boxen";
import ora from "ora";
import {
  input,
  password,
  confirm,
  select,
  checkbox,
  number,
} from "@inquirer/prompts";

// ─── Constants ──────────────────────────────────────────────────────

const VERSION = "0.1.0";
const NEXUS_DIR = join(homedir(), ".nexus");
const CONFIG_PATH = join(NEXUS_DIR, "config.json");
const ENV_PATH = join(process.cwd(), ".env");
const DB_PATH = join(NEXUS_DIR, "memory.db");

// ─── Branding ───────────────────────────────────────────────────────

const nexusGradient = gradient(["#00d4ff", "#6366f1", "#a855f7", "#d946ef"]);
const headerGradient = gradient(["#06b6d4", "#8b5cf6"]);
const accentGradient = gradient(["#a855f7", "#ec4899"]);

const LOGO = `
    ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
    ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
    ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
    ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
    ██║ ╚████║███████╗██╔╝ ╚██╗╚██████╔╝███████║
    ╚═╝  ╚═══╝╚══════╝╚═╝   ╚═╝ ╚═════╝ ╚══════╝`;

// ─── Helpers ────────────────────────────────────────────────────────

function clearScreen(): void {
  process.stdout.write("\x1Bc");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stepHeader(step: number, total: number, title: string): void {
  console.log("");
  console.log(
    boxen(
      headerGradient(`Step ${step}/${total}`) +
        "  " +
        chalk.bold.white(title),
      {
        padding: { left: 2, right: 2, top: 0, bottom: 0 },
        borderStyle: "round",
        borderColor: "cyan",
        dimBorder: true,
      }
    )
  );
  console.log("");
}

// ─── Welcome Screen ─────────────────────────────────────────────────

function showWelcome(): void {
  clearScreen();
  console.log(nexusGradient.multiline(LOGO));
  console.log("");
  console.log(
    boxen(
      chalk.bold.white("Welcome to NEXUS Setup") +
        "\n\n" +
        chalk.dim("Personal AI That Lives On Your Mac") +
        "\n" +
        chalk.dim(`Version ${VERSION}`) +
        "\n\n" +
        chalk.white("This wizard will configure:") +
        "\n" +
        chalk.cyan("  → ") +
        chalk.white("Telegram bot connection") +
        "\n" +
        chalk.cyan("  → ") +
        chalk.white("AI providers & API keys") +
        "\n" +
        chalk.cyan("  → ") +
        chalk.white("Agent capabilities") +
        "\n" +
        chalk.cyan("  → ") +
        chalk.white("Personality & behavior") +
        "\n" +
        chalk.cyan("  → ") +
        chalk.white("macOS permissions") +
        "\n\n" +
        chalk.dim("Press Ctrl+C at any time to cancel."),
      {
        padding: 1,
        margin: { left: 2, right: 0, top: 0, bottom: 0 },
        borderStyle: "double",
        borderColor: "magenta",
      }
    )
  );
  console.log("");
}

// ─── Step 1: System Checks ──────────────────────────────────────────

async function runSystemChecks(): Promise<void> {
  stepHeader(1, 8, "System Check");

  const checks = [
    {
      name: "Node.js version",
      check: () => {
        const v = process.versions.node;
        const major = Number.parseInt(v.split(".")[0]!, 10);
        if (major >= 22) return `v${v}`;
        throw new Error(`v${v} — requires v22+`);
      },
    },
    {
      name: "pnpm available",
      check: () => {
        try {
          const v = execSync("pnpm -v", { encoding: "utf-8" }).trim();
          return `v${v}`;
        } catch {
          throw new Error("not found");
        }
      },
    },
    {
      name: "macOS version",
      check: () => {
        try {
          const v = execSync("sw_vers -productVersion", {
            encoding: "utf-8",
          }).trim();
          return `macOS ${v}`;
        } catch {
          throw new Error("could not detect");
        }
      },
    },
    {
      name: "Screen Recording permission",
      check: () => {
        // We can't programmatically check this reliably, so we just note it
        return "manual verification needed";
      },
      isWarning: true,
    },
    {
      name: "Accessibility permission",
      check: () => {
        return "manual verification needed";
      },
      isWarning: true,
    },
  ];

  for (const item of checks) {
    const spin = ora({
      text: chalk.dim(item.name),
      color: "cyan",
      indent: 2,
    }).start();
    await sleep(300 + Math.random() * 400);
    try {
      const result = item.check();
      if ((item as { isWarning?: boolean }).isWarning) {
        spin.warn(chalk.yellow(item.name) + chalk.dim(` — ${result}`));
      } else {
        spin.succeed(chalk.green(item.name) + chalk.dim(` — ${result}`));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown error";
      spin.fail(chalk.red(item.name) + chalk.dim(` — ${msg}`));
    }
  }
}

// ─── Step 2: Telegram Setup ─────────────────────────────────────────

async function setupTelegram(): Promise<{
  botToken: string;
  chatId: string;
}> {
  stepHeader(2, 8, "Telegram Bot Setup");

  console.log(
    boxen(
      chalk.bold.white("Getting Your Bot Token") +
        "\n\n" +
        chalk.white("1.") +
        chalk.dim(" Open Telegram and search for ") +
        chalk.cyan("@BotFather") +
        "\n" +
        chalk.white("2.") +
        chalk.dim(" Send ") +
        chalk.cyan("/newbot") +
        chalk.dim(" and follow the instructions") +
        "\n" +
        chalk.white("3.") +
        chalk.dim(" Copy the bot token provided") +
        "\n\n" +
        chalk.bold.white("Getting Your Chat ID") +
        "\n\n" +
        chalk.white("1.") +
        chalk.dim(" Send any message to your new bot") +
        "\n" +
        chalk.white("2.") +
        chalk.dim(" Visit: ") +
        chalk.cyan("https://api.telegram.org/bot<TOKEN>/getUpdates") +
        "\n" +
        chalk.white("3.") +
        chalk.dim(" Find ") +
        chalk.white("chat.id") +
        chalk.dim(" in the JSON response"),
      {
        padding: 1,
        margin: { left: 2, right: 0, top: 0, bottom: 0 },
        borderStyle: "round",
        borderColor: "cyan",
      }
    )
  );
  console.log("");

  const botToken = await password({
    message: chalk.magenta("Telegram Bot Token:"),
    mask: "•",
    validate: (val: string) => {
      if (!val || val.length < 20) {
        return "Token looks too short. Paste the full token from BotFather.";
      }
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(val)) {
        return 'Token format should be like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
      }
      return true;
    },
  });

  const chatId = await input({
    message: chalk.magenta("Your Telegram Chat ID:"),
    validate: (val: string) => {
      if (!/^-?\d+$/.test(val)) {
        return "Chat ID should be a number (e.g., 123456789).";
      }
      return true;
    },
  });

  const spin = ora({
    text: "Validating Telegram configuration...",
    color: "cyan",
    indent: 2,
  }).start();
  await sleep(800);
  spin.succeed(chalk.green("Telegram configured"));

  return { botToken, chatId };
}

// ─── Step 3: AI Provider Setup ──────────────────────────────────────

interface AIConfig {
  providers: string[];
  anthropicKey: string;
  openaiKey: string;
  geminiKey: string;
  ollamaEnabled: boolean;
}

async function setupAI(): Promise<AIConfig> {
  stepHeader(3, 8, "AI Provider Setup");

  console.log(
    boxen(
      chalk.dim(
        "Select which AI providers to use.\n" +
          "Anthropic (Claude) is recommended as the primary provider."
      ),
      {
        padding: { left: 2, right: 2, top: 0, bottom: 0 },
        margin: { left: 2, right: 0, top: 0, bottom: 0 },
        borderStyle: "round",
        borderColor: "cyan",
        dimBorder: true,
      }
    )
  );
  console.log("");

  const providers = await checkbox({
    message: chalk.magenta("Select AI providers:"),
    choices: [
      {
        name:
          chalk.bold("Anthropic (Claude)") +
          chalk.dim(" — Recommended primary"),
        value: "anthropic",
        checked: true,
      },
      {
        name: chalk.bold("OpenAI (GPT-4)") + chalk.dim(" — Fallback option"),
        value: "openai",
        checked: false,
      },
      {
        name:
          chalk.bold("Google Gemini") +
          chalk.dim(" — gemini-2.5-flash via OpenAI-compat endpoint"),
        value: "gemini",
        checked: false,
      },
      {
        name:
          chalk.bold("Ollama (Local)") + chalk.dim(" — Free, runs on device"),
        value: "ollama",
        checked: false,
      },
    ],
  });

  let anthropicKey = "";
  let openaiKey = "";
  let geminiKey = "";
  let ollamaEnabled = false;

  if (providers.includes("anthropic")) {
    console.log("");
    anthropicKey = await password({
      message: chalk.magenta("Anthropic API Key:"),
      mask: "•",
      validate: (val: string) => {
        if (!val || val.length < 10) {
          return "API key looks too short.";
        }
        return true;
      },
    });
  }

  if (providers.includes("openai")) {
    console.log("");
    openaiKey = await password({
      message: chalk.magenta("OpenAI API Key:"),
      mask: "•",
      validate: (val: string) => {
        if (!val || val.length < 10) {
          return "API key looks too short.";
        }
        return true;
      },
    });
  }

  if (providers.includes("gemini")) {
    console.log("");
    geminiKey = await password({
      message: chalk.magenta("Google Gemini API Key:"),
      mask: "•",
      validate: (val: string) => {
        if (!val || val.length < 10) {
          return "API key looks too short.";
        }
        return true;
      },
    });
  }

  if (providers.includes("ollama")) {
    ollamaEnabled = true;
    const spin = ora({
      text: "Checking Ollama local server...",
      color: "cyan",
      indent: 2,
    }).start();
    await sleep(600);
    try {
      execSync("curl -s http://localhost:11434/api/tags", {
        timeout: 3000,
      });
      spin.succeed(chalk.green("Ollama is running locally"));
    } catch {
      spin.warn(
        chalk.yellow("Ollama not detected") +
          chalk.dim(" — make sure it's running before starting NEXUS")
      );
    }
  }

  if (!anthropicKey && !openaiKey && !geminiKey && !ollamaEnabled) {
    console.log("");
    console.log(
      boxen(
        chalk.yellow.bold("⚠  No AI Provider Configured") +
          "\n\n" +
          chalk.dim(
            "NEXUS requires at least one AI provider to function.\n" +
              "You can add API keys later in ~/.nexus/config.json"
          ),
        {
          padding: 1,
          margin: { left: 2, right: 0, top: 0, bottom: 0 },
          borderStyle: "round",
          borderColor: "yellow",
        }
      )
    );
  }

  return { providers, anthropicKey, openaiKey, geminiKey, ollamaEnabled };
}

// ─── Step 4: Agent Selection ────────────────────────────────────────

async function setupAgents(): Promise<string[]> {
  stepHeader(4, 8, "Agent Selection");

  console.log(
    boxen(
      chalk.dim(
        "NEXUS uses specialized agents for different tasks.\n" +
          "All agents are enabled by default — disable any you don't need."
      ),
      {
        padding: { left: 2, right: 2, top: 0, bottom: 0 },
        margin: { left: 2, right: 0, top: 0, bottom: 0 },
        borderStyle: "round",
        borderColor: "cyan",
        dimBorder: true,
      }
    )
  );
  console.log("");

  const agents = await checkbox({
    message: chalk.magenta("Enable agents:"),
    choices: [
      {
        name: "👁  VISION     — Screenshots, screen analysis, OCR",
        value: "vision",
        checked: true,
      },
      {
        name: "📁 FILE       — File operations, search, organization",
        value: "file",
        checked: true,
      },
      {
        name: "🌐 BROWSER    — Web browsing, scraping, search",
        value: "browser",
        checked: true,
      },
      {
        name: "💻 TERMINAL   — Shell commands, scripts",
        value: "terminal",
        checked: true,
      },
      {
        name: "🔧 CODE       — Read, write, debug, run code",
        value: "code",
        checked: true,
      },
      {
        name: "🔍 RESEARCH   — Web research, summarization",
        value: "research",
        checked: true,
      },
      {
        name: "⚙️  SYSTEM     — System monitoring, app management",
        value: "system",
        checked: true,
      },
      {
        name: "🎨 CREATIVE   — Text generation, brainstorming",
        value: "creative",
        checked: true,
      },
      {
        name: "📧 COMMS      — Notifications, email drafts",
        value: "comms",
        checked: true,
      },
      {
        name: "⏰ SCHEDULER  — Reminders, scheduled tasks",
        value: "scheduler",
        checked: true,
      },
    ],
  });

  console.log("");
  console.log(
    chalk.dim(`  ${agents.length}/10 agents enabled`)
  );

  return agents;
}

// ─── Step 5: Personality Setup ──────────────────────────────────────

interface PersonalityTraits {
  humor: number;
  sarcasm: number;
  formality: number;
  assertiveness: number;
  verbosity: number;
  empathy: number;
}

async function setupPersonality(): Promise<{
  preset: string;
  traits: PersonalityTraits;
}> {
  stepHeader(5, 8, "Personality Setup");

  console.log(
    boxen(
      chalk.dim(
        "Choose how NEXUS communicates with you.\n" +
          "This affects tone, humor level, and communication style."
      ),
      {
        padding: { left: 2, right: 2, top: 0, bottom: 0 },
        margin: { left: 2, right: 0, top: 0, bottom: 0 },
        borderStyle: "round",
        borderColor: "cyan",
        dimBorder: true,
      }
    )
  );
  console.log("");

  const presets: Record<string, PersonalityTraits> = {
    professional: {
      humor: 0.2,
      sarcasm: 0.1,
      formality: 0.8,
      assertiveness: 0.5,
      verbosity: 0.4,
      empathy: 0.5,
    },
    friendly: {
      humor: 0.7,
      sarcasm: 0.3,
      formality: 0.3,
      assertiveness: 0.5,
      verbosity: 0.6,
      empathy: 0.8,
    },
    sarcastic_genius: {
      humor: 0.9,
      sarcasm: 0.8,
      formality: 0.2,
      assertiveness: 0.8,
      verbosity: 0.5,
      empathy: 0.4,
    },
    custom: {
      humor: 0.5,
      sarcasm: 0.5,
      formality: 0.5,
      assertiveness: 0.5,
      verbosity: 0.5,
      empathy: 0.5,
    },
  };

  const preset = await select({
    message: chalk.magenta("Personality preset:"),
    default: "friendly",
    choices: [
      {
        name:
          chalk.bold("Professional") +
          chalk.dim(" — Low humor, high formality, moderate assertiveness"),
        value: "professional",
      },
      {
        name:
          chalk.bold("Friendly") +
          chalk.dim(
            " — High humor, low formality, moderate assertiveness"
          ) +
          chalk.cyan(" (recommended)"),
        value: "friendly",
      },
      {
        name:
          chalk.bold("Sarcastic Genius") +
          chalk.dim(" — High humor, high sarcasm, high assertiveness"),
        value: "sarcastic_genius",
      },
      {
        name:
          chalk.bold("Custom") +
          chalk.dim(" — Configure each trait manually"),
        value: "custom",
      },
    ],
  });

  let traits = presets[preset]!;

  if (preset === "custom") {
    console.log("");
    console.log(
      chalk.dim("  Rate each trait from 0 (low) to 10 (high):")
    );
    console.log("");

    const traitNames: Array<{ key: keyof PersonalityTraits; label: string; description: string }> = [
      { key: "humor", label: "Humor", description: "How funny/playful responses are" },
      { key: "sarcasm", label: "Sarcasm", description: "Level of sarcastic wit" },
      { key: "formality", label: "Formality", description: "How formal the language is" },
      { key: "assertiveness", label: "Assertiveness", description: "How strongly opinions are expressed" },
      { key: "verbosity", label: "Verbosity", description: "How detailed responses are" },
      { key: "empathy", label: "Empathy", description: "How emotionally aware responses are" },
    ];

    const customTraits: PersonalityTraits = { humor: 0.5, sarcasm: 0.5, formality: 0.5, assertiveness: 0.5, verbosity: 0.5, empathy: 0.5 };

    for (const trait of traitNames) {
      const val = await number({
        message: chalk.magenta(`${trait.label}`) + chalk.dim(` (${trait.description}):`),
        default: 5,
        min: 0,
        max: 10,
      });
      customTraits[trait.key] = (val ?? 5) / 10;
    }

    traits = customTraits;
  }

  // Show personality summary
  console.log("");
  const barWidth = 20;
  const traitBar = (value: number): string => {
    const filled = Math.round(value * barWidth);
    const empty = barWidth - filled;
    return (
      chalk.magenta("█".repeat(filled)) +
      chalk.dim("░".repeat(empty)) +
      chalk.dim(` ${(value * 10).toFixed(0)}/10`)
    );
  };

  console.log(chalk.dim("  Personality profile:"));
  console.log(`  Humor:         ${traitBar(traits.humor)}`);
  console.log(`  Sarcasm:       ${traitBar(traits.sarcasm)}`);
  console.log(`  Formality:     ${traitBar(traits.formality)}`);
  console.log(`  Assertiveness: ${traitBar(traits.assertiveness)}`);
  console.log(`  Verbosity:     ${traitBar(traits.verbosity)}`);
  console.log(`  Empathy:       ${traitBar(traits.empathy)}`);

  return { preset, traits };
}

// ─── Step 6: Permissions ────────────────────────────────────────────

interface PermCheck {
  name: string;
  key: string;
  prefsUrl: string;
  description: string;
  test: () => Promise<boolean>;
}

async function runPermissionTest(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await fn();
  } catch {
    return false;
  }
}

async function setupPermissions(): Promise<void> {
  stepHeader(6, 8, "macOS Permissions");

  console.log(
    boxen(
      chalk.bold.white("Checking macOS Permissions") +
        "\n\n" +
        chalk.dim(
          "NEXUS needs these permissions to work properly.\n" +
            "We'll test each one and open System Settings for any that are missing."
        ),
      {
        padding: 1,
        margin: { left: 2, right: 0, top: 0, bottom: 0 },
        borderStyle: "round",
        borderColor: "cyan",
      }
    )
  );
  console.log("");

  const NODE_BIN = process.execPath;

  const checks: PermCheck[] = [
    {
      name: "Screen Recording",
      key: "screenRecording",
      prefsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      description: `Enable for: ${NODE_BIN}`,
      test: async () => {
        const { execFileSync } = await import("node:child_process");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { unlinkSync, existsSync } = await import("node:fs");
        const testPath = join(tmpdir(), `nexus-setup-test-${Date.now()}.png`);
        try {
          execFileSync("/usr/sbin/screencapture", ["-x", testPath], { timeout: 5000 });
          if (existsSync(testPath)) {
            unlinkSync(testPath);
            return true;
          }
          return false;
        } catch {
          return false;
        }
      },
    },
    {
      name: "Accessibility",
      key: "accessibility",
      prefsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      description: `Enable for: ${NODE_BIN}`,
      test: async () => {
        const { execFileSync } = await import("node:child_process");
        try {
          const result = execFileSync(
            "osascript",
            ["-l", "JavaScript", "-e", "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()"],
            { timeout: 3000, encoding: "utf-8" }
          );
          return result.trim() === "true";
        } catch {
          return false;
        }
      },
    },
    {
      name: "Full Disk Access",
      key: "fullDiskAccess",
      prefsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      description: `Enable for: ${NODE_BIN} (optional — needed for protected file access)`,
      test: async () => {
        const { execFileSync } = await import("node:child_process");
        try {
          execFileSync("sqlite3", ["/Library/Application Support/com.apple.TCC/TCC.db", ".tables"], {
            timeout: 3000,
          });
          return true;
        } catch {
          return false;
        }
      },
    },
    {
      name: "Automation",
      key: "automation",
      prefsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
      description: `Enable for: ${NODE_BIN}`,
      test: async () => {
        const { execFileSync } = await import("node:child_process");
        try {
          execFileSync("osascript", ["-e", 'tell application "Finder" to return name'], {
            timeout: 3000,
          });
          return true;
        } catch {
          return false;
        }
      },
    },
  ];

  const results: Record<string, boolean> = {};

  for (const check of checks) {
    const spin = ora({
      text: chalk.dim(`Checking ${check.name}...`),
      color: "cyan",
      indent: 2,
    }).start();

    const granted = await runPermissionTest(check.test);
    results[check.key] = granted;

    if (granted) {
      spin.succeed(chalk.green(check.name) + chalk.dim(" — granted"));
    } else {
      spin.warn(chalk.yellow(check.name) + chalk.dim(" — not granted"));
    }
  }

  const missing = checks.filter((c) => !results[c.key]);

  if (missing.length === 0) {
    console.log("");
    console.log(
      chalk.dim("  ") + chalk.green("All permissions granted. NEXUS is ready to go!")
    );
    return;
  }

  console.log("");
  console.log(
    boxen(
      chalk.yellow.bold(`${missing.length} permission(s) need your attention`) +
        "\n\n" +
        missing
          .map(
            (c) =>
              chalk.bold(c.name) +
              "\n" +
              chalk.dim(`  ${c.description}`) +
              "\n" +
              chalk.cyan(`  System Settings → Privacy & Security → ${c.name}`)
          )
          .join("\n\n") +
        "\n\n" +
        chalk.dim(
          `The key thing: grant permission to the node binary at:\n  ${NODE_BIN}`
        ),
      {
        padding: 1,
        margin: { left: 2, right: 0, top: 0, bottom: 0 },
        borderStyle: "round",
        borderColor: "yellow",
      }
    )
  );
  console.log("");

  // Open System Settings panes for missing permissions
  const { execSync } = await import("node:child_process");
  for (const check of missing) {
    try {
      execSync(`open "${check.prefsUrl}"`, { timeout: 3000 });
      await sleep(500);
    } catch {
      // ignore
    }
  }

  await select({
    message: chalk.magenta("Permission status:"),
    choices: [
      {
        name: chalk.green("I've granted the missing permissions"),
        value: "done",
      },
      {
        name: chalk.yellow("I'll do this later") + chalk.dim(" (some agents may not work)"),
        value: "skip",
      },
    ],
  });
}

// ─── Step 7: Write Configuration ────────────────────────────────────

async function writeConfiguration(opts: {
  telegram: { botToken: string; chatId: string };
  ai: AIConfig;
  agents: string[];
  personality: { preset: string; traits: PersonalityTraits };
}): Promise<void> {
  stepHeader(7, 8, "Configuration Generation");

  const spin = ora({
    text: "Generating configuration...",
    color: "magenta",
    indent: 2,
  }).start();

  await sleep(600);

  // Ensure directory exists
  mkdirSync(NEXUS_DIR, { recursive: true });
  mkdirSync(join(NEXUS_DIR, "logs"), { recursive: true });
  mkdirSync(join(NEXUS_DIR, "screenshots"), { recursive: true });
  mkdirSync(join(NEXUS_DIR, "data"), { recursive: true });

  spin.text = "Writing config.json...";
  await sleep(400);

  // Build config object
  const config = {
    version: VERSION,
    personality: {
      name: "NEXUS",
      preset: opts.personality.preset,
      traits: opts.personality.traits,
      opinions: { enabled: true, pushbackThreshold: 0.6 },
    },
    memory: {
      dbPath: DB_PATH,
      consolidationSchedule: "0 3 * * *",
      maxShortTerm: 50,
      retrievalTopK: 20,
      importanceThreshold: 0.3,
    },
    ai: {
      provider: opts.ai.anthropicKey
        ? "anthropic"
        : opts.ai.openaiKey
          ? "openai"
          : opts.ai.geminiKey
            ? "gemini"
            : "ollama",
      model: opts.ai.anthropicKey
        ? "claude-sonnet-4-20250514"
        : opts.ai.openaiKey
          ? "gpt-4o"
          : opts.ai.geminiKey
            ? "gemini-2.5-flash"
            : "llama3",
      baseURL: opts.ai.geminiKey
        ? "https://generativelanguage.googleapis.com/v1beta/openai/"
        : undefined,
      fallbackModel: opts.ai.openaiKey
        ? "gpt-4o-mini"
        : "claude-haiku-4-5-20251001",
      maxTokens: 8192,
      temperature: 0.7,
      providers: opts.ai.providers,
    },
    telegram: {
      allowedUsers: [opts.telegram.chatId],
    },
    macos: {
      screenshotQuality: 0.8,
      accessibilityEnabled: true,
    },
    agents: {
      autoDelegate: true,
      maxConcurrent: 5,
      timeoutSeconds: 300,
      enabled: opts.agents,
    },
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  spin.text = "Writing .env file...";
  await sleep(300);

  // Build .env file
  const envLines = [
    "# ─── NEXUS Environment ────────────────────────────────",
    `# Generated by NEXUS Setup on ${new Date().toISOString().split("T")[0]}`,
    "",
    "# Telegram",
    `TELEGRAM_BOT_TOKEN=${opts.telegram.botToken}`,
    `TELEGRAM_CHAT_ID=${opts.telegram.chatId}`,
    "",
    "# AI Providers",
    opts.ai.anthropicKey
      ? `ANTHROPIC_API_KEY=${opts.ai.anthropicKey}`
      : "# ANTHROPIC_API_KEY=",
    opts.ai.openaiKey
      ? `OPENAI_API_KEY=${opts.ai.openaiKey}`
      : "# OPENAI_API_KEY=",
    opts.ai.geminiKey
      ? `GEMINI_API_KEY=${opts.ai.geminiKey}`
      : "# GEMINI_API_KEY=",
    opts.ai.ollamaEnabled
      ? "OLLAMA_BASE_URL=http://localhost:11434"
      : "# OLLAMA_BASE_URL=http://localhost:11434",
    "",
    "# System",
    `NEXUS_DATA_DIR=${NEXUS_DIR}`,
    "NEXUS_LOG_LEVEL=info",
    "",
  ];

  writeFileSync(ENV_PATH, envLines.join("\n"), "utf-8");

  spin.succeed(chalk.green("Configuration saved"));

  // Show what was created
  console.log("");
  console.log(chalk.dim("  Files created:"));
  console.log(
    chalk.dim("  ├── ") + chalk.white(CONFIG_PATH) + chalk.dim(" (settings)")
  );
  console.log(
    chalk.dim("  ├── ") + chalk.white(ENV_PATH) + chalk.dim(" (secrets)")
  );
  console.log(
    chalk.dim("  └── ") + chalk.white(NEXUS_DIR + "/") + chalk.dim(" (data directory)")
  );
}

// ─── Step 8: Database Init ──────────────────────────────────────────

async function initDatabase(): Promise<void> {
  stepHeader(8, 8, "Database Initialization");

  const spin = ora({
    text: "Initializing memory database...",
    color: "magenta",
    indent: 2,
  }).start();

  await sleep(500);

  try {
    // Dynamic import for better-sqlite3
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(DB_PATH);

    // Enable WAL mode for better performance
    db.pragma("journal_mode = WAL");

    // Create tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('episodic', 'semantic', 'procedural')),
        content TEXT NOT NULL,
        embedding BLOB,
        importance REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0,
        last_accessed TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        tokens INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'completed', 'failed', 'cancelled')),
        agent TEXT,
        priority INTEGER DEFAULT 5,
        created_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS context (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent);
    `);

    db.close();

    spin.succeed(chalk.green("Memory database initialized"));
    console.log(
      chalk.dim(`  Database: ${DB_PATH}`)
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "unknown error";
    spin.warn(
      chalk.yellow("Database initialization skipped") +
        chalk.dim(` — ${msg}`)
    );
    console.log(
      chalk.dim(
        "  The database will be created automatically when NEXUS starts."
      )
    );
  }
}

// ─── Celebration Screen ─────────────────────────────────────────────

function showCelebration(opts: {
  agents: string[];
  ai: AIConfig;
  personality: { preset: string; traits: PersonalityTraits };
}): void {
  clearScreen();
  console.log(nexusGradient.multiline(LOGO));
  console.log("");

  const primaryProvider = opts.ai.anthropicKey
    ? "Anthropic Claude"
    : opts.ai.openaiKey
      ? "OpenAI GPT-4"
      : opts.ai.geminiKey
        ? "Google Gemini 2.5 Flash"
        : opts.ai.ollamaEnabled
          ? "Ollama (local)"
          : "None configured";

  console.log(
    boxen(
      accentGradient("✨  NEXUS is ready!  ✨") +
        "\n\n" +
        chalk.white("Your personal AI is configured and waiting.") +
        "\n\n" +
        chalk.dim("─────────────────────────────────────────") +
        "\n\n" +
        chalk.cyan("  Agents:       ") +
        chalk.white(`${opts.agents.length}/10 enabled`) +
        "\n" +
        chalk.cyan("  AI Provider:  ") +
        chalk.white(primaryProvider) +
        "\n" +
        chalk.cyan("  Personality:  ") +
        chalk.white(
          opts.personality.preset.charAt(0).toUpperCase() +
            opts.personality.preset.slice(1).replace("_", " ")
        ) +
        "\n" +
        chalk.cyan("  Config:       ") +
        chalk.white(CONFIG_PATH) +
        "\n" +
        chalk.cyan("  Database:     ") +
        chalk.white(DB_PATH) +
        "\n\n" +
        chalk.dim("─────────────────────────────────────────") +
        "\n\n" +
        chalk.bold.white("Next Steps:") +
        "\n\n" +
        chalk.green("  1. ") +
        chalk.white("Start NEXUS:  ") +
        chalk.cyan.bold("pnpm dev") +
        "\n" +
        chalk.green("  2. ") +
        chalk.white("Open Telegram and send ") +
        chalk.cyan.bold("/start") +
        chalk.white(" to your bot") +
        "\n" +
        chalk.green("  3. ") +
        chalk.white("Try: ") +
        chalk.dim('"Take a screenshot of my desktop"') +
        "\n" +
        chalk.green("  4. ") +
        chalk.white("Try: ") +
        chalk.dim('"What files are on my desktop?"'),
      {
        padding: 1,
        margin: { left: 2, right: 0, top: 0, bottom: 0 },
        borderStyle: "double",
        borderColor: "green",
        title: "  Setup Complete  ",
        titleAlignment: "center",
      }
    )
  );

  console.log("");
  console.log(
    chalk.dim("    NEXUS — Not an assistant. A presence.")
  );
  console.log("");
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  showWelcome();

  // Step 1: System checks
  await runSystemChecks();

  // Step 2: Telegram
  const telegram = await setupTelegram();

  // Step 3: AI providers
  const ai = await setupAI();

  // Step 4: Agents
  const agents = await setupAgents();

  // Step 5: Personality
  const personality = await setupPersonality();

  // Step 6: Permissions
  await setupPermissions();

  // Step 7: Write config
  await writeConfiguration({ telegram, ai, agents, personality });

  // Step 8: Database
  await initDatabase();

  // Celebration
  showCelebration({ agents, ai, personality });
}

main().catch((err: unknown) => {
  console.error("");
  console.error(
    boxen(
      chalk.red.bold("Setup Failed") +
        "\n\n" +
        chalk.white(err instanceof Error ? err.message : String(err)) +
        "\n\n" +
        chalk.dim("If this keeps happening, try:") +
        "\n" +
        chalk.dim("  1. Run ") +
        chalk.cyan("pnpm install") +
        chalk.dim(" first") +
        "\n" +
        chalk.dim("  2. Check Node.js version: ") +
        chalk.cyan("node -v") +
        "\n" +
        chalk.dim("  3. Re-run: ") +
        chalk.cyan("pnpm setup"),
      {
        padding: 1,
        margin: { left: 2, right: 0, top: 0, bottom: 0 },
        borderStyle: "round",
        borderColor: "red",
      }
    )
  );
  console.error("");
  process.exit(1);
});
