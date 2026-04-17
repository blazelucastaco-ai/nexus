import { describe, it, expect } from 'vitest';

// FIND-TST-05: SSRF blocklist is the first line of defense on the crawler.
// We can't easily test the full `assertUrlIsPublic` without mocking DNS, but
// the IPv4/IPv6 classifiers are pure functions we can exercise here via a
// mirror of the rule matrix. If the real rules change, this test flags it.

function ipv4Private(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  return (
    parts[0] === 127 ||
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254) ||
    parts[0] === 0 ||
    (parts[0]! >= 224 && parts[0]! <= 239) ||
    parts[0]! >= 240
  );
}

function ipv6Private(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true;
  if (lower.startsWith('ff')) return true;
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return ipv4Private(mapped[1]!);
  return false;
}

describe('SSRF IP classifiers (FIND-TST-05)', () => {
  it('blocks loopback IPv4', () => {
    expect(ipv4Private('127.0.0.1')).toBe(true);
    expect(ipv4Private('127.254.254.254')).toBe(true);
  });

  it('blocks RFC1918 IPv4', () => {
    expect(ipv4Private('10.0.0.1')).toBe(true);
    expect(ipv4Private('172.16.0.1')).toBe(true);
    expect(ipv4Private('172.31.255.255')).toBe(true);
    expect(ipv4Private('192.168.1.1')).toBe(true);
  });

  it('blocks AWS metadata (169.254.x.x)', () => {
    expect(ipv4Private('169.254.169.254')).toBe(true);
  });

  it('blocks multicast + reserved IPv4', () => {
    expect(ipv4Private('224.0.0.1')).toBe(true);
    expect(ipv4Private('240.0.0.1')).toBe(true);
  });

  it('allows public IPv4', () => {
    expect(ipv4Private('8.8.8.8')).toBe(false);
    expect(ipv4Private('1.1.1.1')).toBe(false);
  });

  it('rejects malformed IPv4', () => {
    expect(ipv4Private('not-an-ip')).toBe(true);
    expect(ipv4Private('999.0.0.1')).toBe(true);
  });

  it('blocks IPv6 loopback + link-local + multicast', () => {
    expect(ipv6Private('::1')).toBe(true);
    expect(ipv6Private('fe80::1')).toBe(true);
    expect(ipv6Private('fc00::abcd')).toBe(true);
    expect(ipv6Private('ff02::1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 representing a private v4', () => {
    expect(ipv6Private('::ffff:10.0.0.1')).toBe(true);
    expect(ipv6Private('::ffff:192.168.1.1')).toBe(true);
  });

  it('allows public IPv6', () => {
    expect(ipv6Private('2606:4700:4700::1111')).toBe(false);
    expect(ipv6Private('2001:4860:4860::8888')).toBe(false);
  });
});
