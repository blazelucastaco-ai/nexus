// APNs VoIP push — the ONLY thing that ever touches Apple. A contentless wake push so
// NEXUS can ring the paired phone for an incoming call, even when the app is closed or
// locked. No caller, no data — just the wake. Token-based auth (a .p8 key); the JWT is
// ES256-signed locally. Config comes from the daemon env (the installer/SETUP.md wire it):
//   APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID  (+ APNS_PRODUCTION=1 for prod)

import { connect } from 'node:http2';
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { createLogger } from '../utils/logger.js';

const log = createLogger('apns');

export interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  production?: boolean;
}

/** Build APNs config from env, or null if not configured (calling stays dormant). */
export function apnsConfigFromEnv(): ApnsConfig | null {
  const keyPath = process.env.APNS_KEY_PATH?.trim();
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  const bundleId = process.env.APNS_BUNDLE_ID?.trim() || 'ai.nexus.companion';
  if (!keyPath || !keyId || !teamId) return null;
  return { keyPath, keyId, teamId, bundleId, production: process.env.APNS_PRODUCTION === '1' };
}

export class ApnsSender {
  private jwt: { token: string; iat: number } | null = null;

  constructor(private readonly cfg: ApnsConfig) {}

  /** Provider JWT, cached < 50 min (Apple requires refresh within an hour). */
  private providerToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now - this.jwt.iat < 3000) return this.jwt.token;
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: this.cfg.keyId }));
    const payload = b64url(JSON.stringify({ iss: this.cfg.teamId, iat: now }));
    const key = createPrivateKey(readFileSync(this.cfg.keyPath));
    const sig = nodeSign('SHA256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
    const token = `${header}.${payload}.${b64url(sig)}`;
    this.jwt = { token, iat: now };
    return token;
  }

  /** Ring the phone — a contentless VoIP push. Resolves true on a 200 from APNs. */
  async ring(deviceToken: string): Promise<boolean> {
    const host = this.cfg.production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
      let client: ReturnType<typeof connect>;
      try {
        client = connect(host);
      } catch (e) {
        log.warn({ err: String(e) }, 'apns connect threw');
        return done(false);
      }
      client.on('error', (e) => { log.warn({ err: String(e) }, 'apns h2 error'); done(false); });
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${this.providerToken()}`,
        'apns-topic': `${this.cfg.bundleId}.voip`,
        'apns-push-type': 'voip',
        'apns-priority': '10',
      });
      let status = 0;
      req.on('response', (h) => { status = Number(h[':status']) || 0; });
      req.on('error', (e) => { log.warn({ err: String(e) }, 'apns request error'); done(false); });
      req.on('end', () => { client.close(); done(status === 200); });
      req.setTimeout(8000, () => { req.close(); client.close(); done(false); });
      req.end(JSON.stringify({ aps: {} })); // contentless
    });
  }
}

function b64url(s: Buffer | string): string {
  return Buffer.from(s).toString('base64url');
}
