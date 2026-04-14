import { describe, it, expect } from 'vitest';
import { classifyMessage, classifyTaskMode, isUndercoverProbe } from '../src/core/task-classifier.js';

describe('classifyMessage', () => {
  describe('task classification', () => {
    it('should classify "build me a landing page" as task', () => {
      expect(classifyMessage('build me a landing page with React')).toBe('task');
    });

    it('should classify "create a Python script" as task', () => {
      expect(classifyMessage('create a Python script to parse JSON files')).toBe('task');
    });

    it('should classify "fix the authentication bug" as task', () => {
      expect(classifyMessage('fix the authentication bug in my code')).toBe('task');
    });

    it('should classify "can you write a function" as task', () => {
      expect(classifyMessage('can you write a function that sorts an array')).toBe('task');
    });

    it('should classify "help me debug this error" as task', () => {
      expect(classifyMessage('help me debug this error in my TypeScript code')).toBe('task');
    });

    it('should classify "install dependencies and run the server" as task', () => {
      expect(classifyMessage('install dependencies and run the server on port 3000')).toBe('task');
    });

    it('should classify "set up a new project" as task', () => {
      expect(classifyMessage('set up a new Node.js project for me')).toBe('task');
    });

    it('should classify "deploy to production" as task', () => {
      expect(classifyMessage('deploy the app to production server')).toBe('task');
    });

    it('should classify "refactor this function" as task', () => {
      expect(classifyMessage('refactor this function to use async/await properly')).toBe('task');
    });

    it('should classify requests containing project keywords as task', () => {
      expect(classifyMessage('I need a dashboard that shows my sales data')).toBe('task');
    });
  });

  describe('chat classification', () => {
    it('should classify greetings as chat', () => {
      expect(classifyMessage('hi')).toBe('chat');
      expect(classifyMessage('hey there')).toBe('chat');
      expect(classifyMessage('hello!')).toBe('chat');
    });

    it('should classify one-word confirmations as chat', () => {
      expect(classifyMessage('yes')).toBe('chat');
      expect(classifyMessage('okay')).toBe('chat');
      expect(classifyMessage('sure')).toBe('chat');
    });

    it('should classify short questions as chat', () => {
      expect(classifyMessage('what is TypeScript?')).toBe('chat');
      expect(classifyMessage('what are arrays?')).toBe('chat');
    });

    it('should classify messages shorter than 15 chars as chat', () => {
      expect(classifyMessage('how?')).toBe('chat');
      expect(classifyMessage('done yet?')).toBe('chat');
    });

    it('should classify capability questions as chat', () => {
      expect(classifyMessage('can you do that?')).toBe('chat');
      expect(classifyMessage('are you able to help?')).toBe('chat');
    });

    it('should classify [PHOTO] prefixed messages as chat', () => {
      expect(classifyMessage('[PHOTO] /path/to/image.jpg\nWhat is this?')).toBe('chat');
    });

    it('should classify [DOCUMENT] prefixed messages as chat', () => {
      expect(classifyMessage('[DOCUMENT] /path/to/doc.pdf')).toBe('chat');
    });

    it('should classify thanks as chat', () => {
      expect(classifyMessage('thanks!')).toBe('chat');
      expect(classifyMessage('thank you')).toBe('chat');
    });
  });
});

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
