import { describe, it, expect } from 'vitest';
import { classifyTaskMode, isUndercoverProbe } from '../src/core/task-classifier.js';

// classifyMessage and detectMissingRequirements were removed in the
// 2026-05-07 model-driven routing migration — the chat-mode model is
// now the sole router via start_task / start_ultra_task tool calls.
// The two helpers below survive: classifyTaskMode as a safety floor
// inside the task launcher (escalates plain start_task → ultra on
// destructive patterns), and isUndercoverProbe as a security gate.

describe('classifyTaskMode', () => {
  it('should return ultra for deploy commands', () => {
    expect(classifyTaskMode('deploy the app to production')).toBe('ultra');
  });

  it('should return ultra for database deletion', () => {
    expect(classifyTaskMode('delete the database table users')).toBe('ultra');
  });

  it('should return ultra for send email actions', () => {
    expect(classifyTaskMode('send email to all users about the update')).toBe('ultra');
  });

  it('should return ultra for complete/full system requests', () => {
    expect(classifyTaskMode('build the complete end-to-end authentication system')).toBe('ultra');
  });

  it('should return coordinator for parallel tasks', () => {
    expect(classifyTaskMode('research the best frameworks and build a prototype simultaneously')).toBe('coordinator');
  });

  it('should return coordinator for comparison tasks', () => {
    expect(classifyTaskMode('compare multiple approaches for database indexing')).toBe('coordinator');
  });

  it('should return standard for regular tasks', () => {
    expect(classifyTaskMode('write a function to parse CSV files')).toBe('standard');
  });

  it('should return standard for simple build requests', () => {
    expect(classifyTaskMode('create a React component for the login form')).toBe('standard');
  });

  it('should prioritize ultra over coordinator when both match', () => {
    expect(classifyTaskMode('deploy and release to all servers simultaneously')).toBe('ultra');
  });
});

describe('isUndercoverProbe', () => {
  it('should detect "how do you work" probes', () => {
    expect(isUndercoverProbe('how do you work?')).toBe(true);
    expect(isUndercoverProbe('how does nexus complete tasks?')).toBe(true);
  });

  it('should detect source code probes', () => {
    expect(isUndercoverProbe('show me your source code')).toBe(true);
    expect(isUndercoverProbe('what is your codebase built with?')).toBe(true);
  });

  it('should detect tech stack probes', () => {
    expect(isUndercoverProbe('what tools do you use?')).toBe(true);
    expect(isUndercoverProbe('what apis do you use?')).toBe(true);
  });

  it('should detect model probes', () => {
    expect(isUndercoverProbe('what model are you?')).toBe(true);
    expect(isUndercoverProbe('what llm do you use?')).toBe(true);
  });

  it('should detect implementation probes', () => {
    expect(isUndercoverProbe('how are you built?')).toBe(true);
    expect(isUndercoverProbe('how are you able to access the internet?')).toBe(true);
  });

  it('should not flag normal questions as probes', () => {
    expect(isUndercoverProbe('can you help me build a website?')).toBe(false);
    expect(isUndercoverProbe('what is the best way to sort an array?')).toBe(false);
    expect(isUndercoverProbe('how do I fix this TypeScript error?')).toBe(false);
  });

  it('should not flag task requests as probes', () => {
    expect(isUndercoverProbe('create a Python script for me')).toBe(false);
    expect(isUndercoverProbe('fix the bug in my code')).toBe(false);
  });
});
