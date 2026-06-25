// The name of the human NEXUS belongs to — for addressing them in prompts.
//
// NEVER hardcode a name in source (this ships to many users via the installer).
// The daemon calls setUserName(config.userName) once at startup; everything that
// builds a prompt reads userName(). When config has no name, we fall back to the
// macOS account's first name, and finally to a neutral "the user".
import { execSync } from 'node:child_process';
import os from 'node:os';

let configured: string | null = null;
let detected: string | null = null;

/** Set from config at daemon startup (empty/undefined → fall back to detection). */
export function setUserName(name: string | undefined | null): void {
  configured = (name ?? '').trim() || null;
}

function detect(): string {
  try {
    // macOS: the account's full name ("Ada Lovelace") — take the first name.
    const full = execSync('id -F', { encoding: 'utf8', timeout: 2000 }).trim();
    const first = full.split(/\s+/)[0];
    if (first) return first;
  } catch {
    /* not macOS / no `id -F` */
  }
  try {
    const u = os.userInfo().username;
    if (u) return u.charAt(0).toUpperCase() + u.slice(1);
  } catch {
    /* ignore */
  }
  return 'the user';
}

/** The user's name for prompts. Configured value → detected macOS name → "the user". */
export function userName(): string {
  if (configured) return configured;
  if (detected === null) detected = detect();
  return detected;
}
