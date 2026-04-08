import {
  readdir,
  readFile,
  writeFile,
  rename,
  unlink,
  stat,
  mkdir,
} from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { nowISO, extractCleanContent } from '../utils/helpers.js';

function expandPath(p: string): string {
  if (p.startsWith('~')) return p.replace(/^~/, homedir());
  return p;
}

const execFileAsync = promisify(execFile);

const EXTENSION_CATEGORIES: Record<string, string[]> = {
  images: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff'],
  documents: ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.pages', '.md', '.csv', '.xls', '.xlsx'],
  code: ['.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.swift', '.kt', '.rb', '.php', '.sh', '.zsh', '.bash'],
  audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma'],
  video: ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm'],
  archives: ['.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz', '.dmg'],
  data: ['.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.env', '.sql', '.db', '.sqlite'],
  fonts: ['.ttf', '.otf', '.woff', '.woff2', '.eot'],
};

function categorizeExtension(ext: string): string {
  const lower = ext.toLowerCase();
  for (const [category, extensions] of Object.entries(EXTENSION_CATEGORIES)) {
    if (extensions.includes(lower)) return category;
  }
  return 'other';
}

export class FileAgent extends BaseAgent {
  constructor() {
    super('file', 'Manages files and directories — list, search, read, write, move, organize', [
      { name: 'list_files', description: 'List files in a directory' },
      { name: 'search_files', description: 'Recursively search for files matching a pattern' },
      { name: 'read_file', description: 'Read the contents of a file' },
      { name: 'write_file', description: 'Write content to a file' },
      { name: 'move_file', description: 'Move or rename a file' },
      { name: 'delete_file', description: 'Delete a file' },
      { name: 'disk_usage', description: 'Show disk usage for a path' },
      { name: 'organize', description: 'Organize files in a directory by extension category' },
    ]);
  }

  async execute(action: string, params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();

    // Defensive normalisation — the orchestrator's delegation parser may pass
    // malformed params if the LLM used an unexpected format.
    params = this.normaliseParams(action, params);

    this.log.info({ action, params }, 'FileAgent executing');

    try {
      switch (action) {
        case 'list_files':
          return await this.listFiles(params, start);
        case 'search_files':
          return await this.searchFiles(params, start);
        case 'read_file':
          return await this.readFile(params, start);
        case 'write_file':
          return await this.writeFile(params, start);
        case 'move_file':
          return await this.moveFile(params, start);
        case 'delete_file':
          return await this.deleteFile(params, start);
        case 'disk_usage':
          return await this.diskUsage(params, start);
        case 'organize':
          return await this.organize(params, start);
        default:
          return this.createResult(false, null, `Unknown action: ${action}`, start);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ action, error: msg }, 'FileAgent failed');
      return this.createResult(false, null, msg, start);
    }
  }

  /**
   * Clean up params that may arrive malformed from the orchestrator parser.
   * Handles: function-call strings as path, action prefixes, trailing colons.
   */
  private normaliseParams(
    action: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const p = { ...params };

    // If path looks like a function call write_file(path='X', content='Y'), parse it
    const rawPath = p.path != null ? String(p.path) : '';
    const funcCallMatch = rawPath.match(/^\w+\s*\(\s*([\s\S]+)\s*\)\s*$/);
    if (funcCallMatch) {
      // Function-call format: write_file(path='X', content='Y')
      const argsStr = funcCallMatch[1]!;

      // Handle triple-quoted strings first (content='''...''' or content="""...""")
      const tripleQuotedRe = /(\w+)\s*=\s*(?:'''([\s\S]*?)'''|"""([\s\S]*?)""")/g;
      let tqm: RegExpExecArray | null;
      while ((tqm = tripleQuotedRe.exec(argsStr)) !== null) {
        p[tqm[1]!] = tqm[2] ?? tqm[3] ?? '';
      }

      // Then handle regular single/double-quoted strings
      const namedParamRe = /(\w+)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
      let pm: RegExpExecArray | null;
      while ((pm = namedParamRe.exec(argsStr)) !== null) {
        const key = pm[1]!;
        if (p[key] != null && p[key] !== '') continue; // skip if triple-quote already set
        const val = (pm[2] ?? pm[3] ?? '').replace(/\\'/g, "'").replace(/\\"/g, '"');
        p[key] = val;
      }
    } else if (rawPath.trimStart().startsWith('{')) {
      // JSON format: {"path": "...", "content": "..."}
      try {
        const jsonParsed = JSON.parse(rawPath.trim()) as Record<string, unknown>;
        Object.assign(p, jsonParsed);
      } catch { /* not valid JSON, fall through */ }
    } else if (rawPath) {
      // Strip action prefix: "read_file:~/path" → "~/path"
      let cleanPath = rawPath.replace(/^(?:write_file|read_file|list_files|search_files|move_file|delete_file|disk_usage|organize|list):\s*/i, '');
      // Strip trailing colons
      cleanPath = cleanPath.replace(/:+$/, '');
      p.path = cleanPath;
    }
    // Expand tilde in path
    if (p.path && typeof p.path === 'string') {
      p.path = p.path.replace(/^~/, homedir());
    }

    return p;
  }

  private async listFiles(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const dir = expandPath(String(params.path ?? '.'));
    const showHidden = Boolean(params.showHidden);

    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((e) => showHidden || !e.name.startsWith('.'))
        .map(async (e) => {
          const fullPath = join(dir, e.name);
          const info = await stat(fullPath).catch(() => null);
          return {
            name: e.name,
            path: fullPath,
            isDirectory: e.isDirectory(),
            size: info?.size ?? 0,
            modified: info?.mtime.toISOString() ?? null,
          };
        }),
    );

    const fileNames = files.map((f) => (f.isDirectory ? `${f.name}/` : f.name)).join('\n');
    const formattedList = `EXACT FILE LIST — copy this verbatim into your reply:\n\`\`\`\n${fileNames}\n\`\`\`\n(${files.length} items in ${dir})`;
    return this.createResult(true, { directory: dir, count: files.length, files, formattedList }, undefined, start);
  }

  private async searchFiles(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const dir = expandPath(String(params.path ?? '.'));
    const pattern = String(params.pattern ?? '*');
    const maxDepth = Number(params.maxDepth ?? 10);
    const maxResults = Number(params.maxResults ?? 100);

    const regex = new RegExp(
      pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.'),
      'i',
    );

    const results: Array<{ name: string; path: string; size: number }> = [];

    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > maxDepth || results.length >= maxResults) return;

      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith('.')) continue;

        const fullPath = join(current, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (regex.test(entry.name)) {
          const info = await stat(fullPath).catch(() => null);
          results.push({ name: entry.name, path: fullPath, size: info?.size ?? 0 });
        }
      }
    };

    await walk(dir, 0);

    return this.createResult(true, { pattern, directory: dir, count: results.length, results }, undefined, start);
  }

  private async readFile(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const filePath = expandPath(String(params.path));
    const encoding = (params.encoding as BufferEncoding) ?? 'utf-8';
    const maxSize = Number(params.maxSize ?? 1_000_000); // 1MB default

    const info = await stat(filePath);
    if (info.size > maxSize) {
      return this.createResult(false, null, `File too large (${info.size} bytes, max ${maxSize})`, start);
    }

    const content = await readFile(filePath, encoding);

    return this.createResult(
      true,
      {
        path: filePath,
        size: info.size,
        lines: content.split('\n').length,
        content,
      },
      undefined,
      start,
    );
  }

  private async writeFile(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const filePath = expandPath(String(params.path));
    // BUG A fix: clean content to remove any markdown fences or LLM prose that
    // leaked into the content parameter
    const rawContent = String(params.content ?? '');
    const content = extractCleanContent(rawContent);
    const createDirs = Boolean(params.createDirs ?? true);

    if (createDirs) {
      await mkdir(dirname(filePath), { recursive: true });
    }

    await writeFile(filePath, content, 'utf-8');
    const info = await stat(filePath);

    this.log.info({ path: filePath, size: info.size }, 'File written');
    return this.createResult(true, { path: filePath, size: info.size, writtenAt: nowISO() }, undefined, start);
  }

  private async moveFile(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const source = expandPath(String(params.source ?? params.from));
    const destination = expandPath(String(params.destination ?? params.to));

    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);

    this.log.info({ source, destination }, 'File moved');
    return this.createResult(true, { source, destination, movedAt: nowISO() }, undefined, start);
  }

  private async deleteFile(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const filePath = expandPath(String(params.path));

    const info = await stat(filePath);
    if (info.isDirectory()) {
      return this.createResult(false, null, 'Cannot delete directories. Use rm -r via terminal agent.', start);
    }

    await unlink(filePath);
    this.log.info({ path: filePath }, 'File deleted');
    return this.createResult(true, { path: filePath, deletedAt: nowISO() }, undefined, start);
  }

  private async diskUsage(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const targetPath = expandPath(String(params.path ?? '.'));
    const { stdout } = await execFileAsync('du', ['-sh', targetPath], { timeout: 10_000 });
    const [size, path] = stdout.trim().split('\t');

    return this.createResult(true, { path, size }, undefined, start);
  }

  private async organize(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const dir = expandPath(String(params.path));
    const dryRun = Boolean(params.dryRun ?? false);

    const entries = await readdir(dir, { withFileTypes: true });
    const moves: Array<{ file: string; from: string; to: string; category: string }> = [];

    for (const entry of entries) {
      if (entry.isDirectory() || entry.name.startsWith('.')) continue;

      const ext = extname(entry.name);
      if (!ext) continue;

      const category = categorizeExtension(ext);
      const sourcePath = join(dir, entry.name);
      const destDir = join(dir, category);
      const destPath = join(destDir, entry.name);

      if (!dryRun) {
        await mkdir(destDir, { recursive: true });
        await rename(sourcePath, destPath);
      }

      moves.push({ file: entry.name, from: sourcePath, to: destPath, category });
    }

    this.log.info({ directory: dir, moved: moves.length, dryRun }, 'Organized files');
    return this.createResult(
      true,
      { directory: dir, dryRun, totalMoved: moves.length, moves },
      undefined,
      start,
    );
  }
}
