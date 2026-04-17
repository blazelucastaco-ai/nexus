import { describe, it, expect, beforeEach } from 'vitest';
import { toolManifests, effectiveRisk, type ToolManifest } from '../src/tools/contract.js';
import { registerBuiltinManifests } from '../src/tools/manifests.js';

describe('Tool manifest registry', () => {
  beforeEach(() => {
    toolManifests.clear();
  });

  it('registers and retrieves manifests by name', () => {
    const m: ToolManifest = {
      name: 'test_tool',
      description: 'A test',
      effects: ['fs.read'],
      risk: 'auto',
    };
    toolManifests.register(m);
    expect(toolManifests.get('test_tool')).toEqual(m);
    expect(toolManifests.has('test_tool')).toBe(true);
    expect(toolManifests.has('missing')).toBe(false);
  });

  it('listByEffect filters by declared effect', () => {
    toolManifests.register({ name: 'a', description: '', effects: ['fs.read'], risk: 'auto' });
    toolManifests.register({ name: 'b', description: '', effects: ['fs.write'], risk: 'logged' });
    toolManifests.register({ name: 'c', description: '', effects: ['net.outbound'], risk: 'auto' });

    const fs = toolManifests.listByEffect(['fs.read', 'fs.write']);
    expect(fs.map((m) => m.name).sort()).toEqual(['a', 'b']);

    const net = toolManifests.listByEffect(['net.outbound']);
    expect(net.map((m) => m.name)).toEqual(['c']);
  });
});

describe('effectiveRisk', () => {
  it('returns the declared risk for safe tools', () => {
    expect(effectiveRisk({ name: 'x', description: '', effects: ['fs.read'], risk: 'auto' })).toBe('auto');
    expect(effectiveRisk({ name: 'x', description: '', effects: ['mem.read'], risk: 'auto' })).toBe('auto');
  });

  it('elevates auto to logged when destructive effects declared', () => {
    expect(effectiveRisk({ name: 'x', description: '', effects: ['fs.write'], risk: 'auto' })).toBe('logged');
    expect(effectiveRisk({ name: 'x', description: '', effects: ['browser.write'], risk: 'auto' })).toBe('logged');
  });

  it('elevates fs.delete to confirm regardless of declared risk', () => {
    expect(effectiveRisk({ name: 'x', description: '', effects: ['fs.delete'], risk: 'auto' })).toBe('confirm');
    expect(effectiveRisk({ name: 'x', description: '', effects: ['fs.delete'], risk: 'logged' })).toBe('confirm');
  });

  it('elevates process.detach to confirm', () => {
    expect(effectiveRisk({ name: 'x', description: '', effects: ['process.detach'], risk: 'auto' })).toBe('confirm');
    expect(effectiveRisk({ name: 'x', description: '', effects: ['process.detach'], risk: 'logged' })).toBe('confirm');
  });

  it('respects declared confirm tier', () => {
    expect(effectiveRisk({ name: 'x', description: '', effects: ['os.screenshot'], risk: 'confirm' })).toBe('confirm');
  });
});

describe('Built-in manifests', () => {
  beforeEach(() => {
    toolManifests.clear();
    registerBuiltinManifests();
  });

  it('registers all expected core tools', () => {
    const expected = [
      'run_terminal_command', 'run_background_command',
      'read_file', 'write_file', 'list_directory',
      'recall', 'remember',
      'web_fetch', 'browser_navigate',
      'understand_image', 'schedule_task',
    ];
    for (const name of expected) {
      expect(toolManifests.has(name)).toBe(true);
    }
  });

  it('write_file is logged tier (destructive)', () => {
    const m = toolManifests.get('write_file');
    expect(m).toBeDefined();
    expect(effectiveRisk(m!)).toBe('logged');
  });

  it('run_background_command requires confirm (detach)', () => {
    const m = toolManifests.get('run_background_command');
    expect(m).toBeDefined();
    expect(effectiveRisk(m!)).toBe('confirm');
  });

  it('read_file is auto (pure read)', () => {
    const m = toolManifests.get('read_file');
    expect(m).toBeDefined();
    expect(effectiveRisk(m!)).toBe('auto');
  });

  it('take_screenshot is confirm (sensitivity)', () => {
    const m = toolManifests.get('take_screenshot');
    expect(m).toBeDefined();
    expect(effectiveRisk(m!)).toBe('confirm');
  });

  it('every manifest has non-empty name and declared effects array', () => {
    for (const m of toolManifests.list()) {
      expect(m.name).toBeTruthy();
      expect(Array.isArray(m.effects)).toBe(true);
    }
  });
});
