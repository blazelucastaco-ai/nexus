import { execFile } from 'node:child_process';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { nowISO } from '../utils/helpers.js';

function expandPath(p: string): string {
  if (p.startsWith('~')) return p.replace(/^~/, homedir());
  return p;
}

const execFileAsync = promisify(execFile);

export class CodeAgent extends BaseAgent {
  constructor() {
    super('code', 'Analyzes code, runs tests, manages git operations, and scaffolds projects', [
      { name: 'analyze_code', description: 'Analyze a source file and return stats (lines, functions, imports, etc.)' },
      { name: 'run_tests', description: 'Run the test suite for a project' },
      { name: 'git_status', description: 'Show git status for a repository' },
      { name: 'git_commit', description: 'Stage and commit changes with a message' },
      { name: 'scaffold_project', description: 'Create a basic project structure' },
      { name: 'lint', description: 'Run the linter on a project or file' },
    ]);
  }

  async execute(action: string, params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    this.log.info({ action, params }, 'CodeAgent executing');

    try {
      switch (action) {
        case 'analyze_code':
          return await this.analyzeCode(params, start);
        case 'run_tests':
          return await this.runTests(params, start);
        case 'git_status':
          return await this.gitStatus(params, start);
        case 'git_commit':
          return await this.gitCommit(params, start);
        case 'scaffold_project':
          return await this.scaffoldProject(params, start);
        case 'lint':
          return await this.lint(params, start);
        default:
          return this.createResult(false, null, `Unknown action: ${action}`, start);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ action, error: msg }, 'CodeAgent failed');
      return this.createResult(false, null, msg, start);
    }
  }

  private async analyzeCode(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const filePath = expandPath(String(params.path));
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const ext = extname(filePath);

    const blankLines = lines.filter((l) => l.trim() === '').length;
    const commentLines = lines.filter((l) => {
      const trimmed = l.trim();
      return trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*');
    }).length;

    // Detect imports
    const importLines = lines.filter((l) => {
      const trimmed = l.trim();
      return (
        trimmed.startsWith('import ') ||
        trimmed.startsWith('from ') ||
        trimmed.startsWith('require(') ||
        trimmed.match(/^const\s+.*=\s*require\(/)
      );
    });

    // Detect function declarations
    const functionPatterns = [
      /function\s+\w+/g,
      /(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(/g,
      /(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\w+\s*=>/g,
      /(?:async\s+)?(?:public|private|protected)?\s*\w+\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/g,
    ];

    const functions: string[] = [];
    for (const line of lines) {
      for (const pattern of functionPatterns) {
        const matches = line.match(pattern);
        if (matches) functions.push(...matches);
      }
    }

    // Detect classes
    const classMatches = content.match(/class\s+\w+/g) ?? [];

    // Detect exports
    const exportLines = lines.filter((l) => l.trim().startsWith('export '));

    return this.createResult(
      true,
      {
        path: filePath,
        extension: ext,
        totalLines: lines.length,
        codeLines: lines.length - blankLines - commentLines,
        blankLines,
        commentLines,
        imports: importLines.length,
        functions: functions.length,
        classes: classMatches.length,
        exports: exportLines.length,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
        analyzedAt: nowISO(),
      },
      undefined,
      start,
    );
  }

  private async runTests(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const cwd = expandPath(String(params.path ?? params.cwd ?? '.'));
    const runner = String(params.runner ?? 'npm test');

    const { stdout, stderr } = await execFileAsync('/bin/zsh', ['-c', runner], {
      cwd,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    });

    return this.createResult(
      true,
      {
        runner,
        cwd,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        ranAt: nowISO(),
      },
      undefined,
      start,
    );
  }

  private async gitStatus(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const cwd = expandPath(String(params.path ?? params.cwd ?? '.'));

    const [status, branch, log] = await Promise.all([
      execFileAsync('git', ['status', '--porcelain'], { cwd, timeout: 5_000 }),
      execFileAsync('git', ['branch', '--show-current'], { cwd, timeout: 5_000 }),
      execFileAsync('git', ['log', '--oneline', '-10'], { cwd, timeout: 5_000 }),
    ]);

    const changes = status.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => ({
        status: line.slice(0, 2).trim(),
        file: line.slice(3),
      }));

    return this.createResult(
      true,
      {
        branch: branch.stdout.trim(),
        changes,
        changedFiles: changes.length,
        recentCommits: log.stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [hash, ...rest] = line.split(' ');
            return { hash, message: rest.join(' ') };
          }),
        checkedAt: nowISO(),
      },
      undefined,
      start,
    );
  }

  private async gitCommit(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const cwd = expandPath(String(params.path ?? params.cwd ?? '.'));
    const message = String(params.message);
    const files = params.files as string[] | undefined;

    if (files && files.length > 0) {
      await execFileAsync('git', ['add', ...files], { cwd, timeout: 5_000 });
    } else {
      await execFileAsync('git', ['add', '-A'], { cwd, timeout: 5_000 });
    }

    const { stdout } = await execFileAsync('git', ['commit', '-m', message], {
      cwd,
      timeout: 10_000,
      env: { ...process.env },
    });

    this.log.info({ message, cwd }, 'Git commit created');
    return this.createResult(
      true,
      { message, output: stdout.trim(), committedAt: nowISO() },
      undefined,
      start,
    );
  }

  private async scaffoldProject(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const name = String(params.name);
    const template = String(params.template ?? 'typescript');
    const baseDir = expandPath(String(params.path ?? '.'));
    const projectDir = join(baseDir, name);

    const structures: Record<string, Record<string, string>> = {
      typescript: {
        'src/index.ts': `// ${name}\nconsole.log('Hello from ${name}');\n`,
        'src/types.ts': `// Type definitions for ${name}\n`,
        'tsconfig.json': JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              outDir: './dist',
              rootDir: './src',
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
              declaration: true,
            },
            include: ['src/**/*'],
          },
          null,
          2,
        ),
        'package.json': JSON.stringify(
          {
            name,
            version: '0.1.0',
            type: 'module',
            main: 'dist/index.js',
            scripts: {
              build: 'tsc',
              dev: 'tsx watch src/index.ts',
              start: 'node dist/index.js',
            },
          },
          null,
          2,
        ),
        '.gitignore': 'node_modules/\ndist/\n.env\n',
      },
      node: {
        'src/index.js': `// ${name}\nconsole.log('Hello from ${name}');\n`,
        'package.json': JSON.stringify(
          {
            name,
            version: '0.1.0',
            type: 'module',
            main: 'src/index.js',
            scripts: { start: 'node src/index.js' },
          },
          null,
          2,
        ),
        '.gitignore': 'node_modules/\n.env\n',
      },
    };

    const structure = structures[template] ?? structures.typescript;
    const createdFiles: string[] = [];

    for (const [relativePath, content] of Object.entries(structure)) {
      const fullPath = join(projectDir, relativePath);
      await mkdir(join(projectDir, relativePath, '..').replace(/\/\.\.$/, ''), { recursive: true });
      // Ensure parent dir exists
      const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      await mkdir(parentDir, { recursive: true });
      await writeFile(fullPath, content, 'utf-8');
      createdFiles.push(relativePath);
    }

    this.log.info({ name, template, projectDir }, 'Project scaffolded');
    return this.createResult(
      true,
      { name, template, path: projectDir, files: createdFiles, createdAt: nowISO() },
      undefined,
      start,
    );
  }

  private async lint(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const cwd = expandPath(String(params.path ?? params.cwd ?? '.'));
    const tool = String(params.tool ?? 'eslint');
    const target = params.target ? String(params.target) : '.';

    const commands: Record<string, string> = {
      eslint: `npx eslint ${target}`,
      biome: `npx @biomejs/biome check ${target}`,
      prettier: `npx prettier --check ${target}`,
      tsc: 'npx tsc --noEmit',
    };

    const command = commands[tool] ?? commands.eslint;

    try {
      const { stdout, stderr } = await execFileAsync('/bin/zsh', ['-c', command], {
        cwd,
        timeout: 60_000,
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env },
      });

      return this.createResult(
        true,
        { tool, target, cwd, stdout: stdout.trim(), stderr: stderr.trim(), clean: true, lintedAt: nowISO() },
        undefined,
        start,
      );
    } catch (err: unknown) {
      // Lint errors cause non-zero exit
      const error = err as { stdout?: string; stderr?: string; code?: number };
      return this.createResult(
        true,
        {
          tool,
          target,
          cwd,
          stdout: error.stdout?.trim() ?? '',
          stderr: error.stderr?.trim() ?? '',
          clean: false,
          exitCode: error.code,
          lintedAt: nowISO(),
        },
        undefined,
        start,
      );
    }
  }
}
