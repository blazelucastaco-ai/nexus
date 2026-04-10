import { describe, it, expect } from 'vitest';
import { clamp, lerp, truncate, escapeHtml, extractCleanContent, generateId, nowISO } from '../src/utils/helpers.js';

describe('clamp', () => {
  it('should return value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('should return min when value is below', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it('should return max when value is above', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('should handle negative ranges', () => {
    expect(clamp(0, -1, 1)).toBe(0);
    expect(clamp(-2, -1, 1)).toBe(-1);
    expect(clamp(2, -1, 1)).toBe(1);
  });

  it('should handle equal min and max', () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });

  it('should handle boundary values exactly', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe('lerp', () => {
  it('should return a when t=0', () => {
    expect(lerp(0, 10, 0)).toBe(0);
  });

  it('should return b when t=1', () => {
    expect(lerp(0, 10, 1)).toBe(10);
  });

  it('should return midpoint when t=0.5', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it('should handle negative values', () => {
    expect(lerp(-10, 10, 0.5)).toBe(0);
  });

  it('should extrapolate beyond 0-1 range', () => {
    expect(lerp(0, 10, 2)).toBe(20);
    expect(lerp(0, 10, -1)).toBe(-10);
  });
});

describe('truncate', () => {
  it('should not truncate short strings', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('should truncate long strings with ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  it('should handle exact length', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('should handle empty string', () => {
    expect(truncate('', 5)).toBe('');
  });

  it('should handle very short maxLen', () => {
    const result = truncate('hello world', 4);
    expect(result).toBe('h...');
  });
});

describe('escapeHtml', () => {
  it('should escape ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('should escape angle brackets', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('should handle multiple special characters', () => {
    expect(escapeHtml('<div class="a & b">')).toBe('&lt;div class="a &amp; b"&gt;');
  });

  it('should leave normal text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('should handle empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('extractCleanContent', () => {
  it('should extract code from markdown fences', () => {
    const input = '```python\nimport os\nprint("hello")\n```';
    const result = extractCleanContent(input);
    expect(result).toBe('import os\nprint("hello")\n');
  });

  it('should extract from fences without language tag', () => {
    const input = '```\nsome code\n```';
    const result = extractCleanContent(input);
    expect(result).toBe('some code\n');
  });

  it('should decode escape sequences when no real newlines exist', () => {
    const input = 'line1\\nline2\\nline3';
    const result = extractCleanContent(input);
    expect(result).toContain('line1');
    expect(result).toContain('line2');
  });

  it('should NOT decode escape sequences when real newlines exist', () => {
    const input = 'line1\nstill has \\n literal';
    const result = extractCleanContent(input);
    expect(result).toContain('\\n');
  });

  it('should strip leading prose before code', () => {
    const input = 'Here is the code:\nimport os\nprint("hello")';
    const result = extractCleanContent(input);
    expect(result).toBe('import os\nprint("hello")');
  });

  it('should pass through plain code unchanged', () => {
    const input = 'const x = 42;\nconsole.log(x);';
    const result = extractCleanContent(input);
    expect(result).toBe('const x = 42;\nconsole.log(x);');
  });
});

describe('generateId', () => {
  it('should return a non-empty string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('nowISO', () => {
  it('should return a valid ISO date string', () => {
    const iso = nowISO();
    expect(() => new Date(iso)).not.toThrow();
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});
