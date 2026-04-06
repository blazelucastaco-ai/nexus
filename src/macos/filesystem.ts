import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  readdir,
  stat,
  rename,
  copyFile as fsCopyFile,
  unlink,
  mkdir,
} from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join, relative } from 'node:path';
import { glob } from 'node:fs/promises';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FileSystem');

export class FileSystem {
  /**
   * Read the contents of a file as UTF-8 text.
   */
  async readFile(path: string): Promise<string> {
    try {
      const content = await fsReadFile(path, 'utf-8');
      logger.debug({ path }, 'File read');
      return content;
    } catch (err) {
      logger.error({ err, path }, 'Failed to read file');
      throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
    }
  }

  /**
   * Write content to a file, creating parent directories as needed.
   */
  async writeFile(path: string, content: string): Promise<void> {
    try {
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (dir) await mkdir(dir, { recursive: true });
      await fsWriteFile(path, content, 'utf-8');
      logger.debug({ path }, 'File written');
    } catch (err) {
      logger.error({ err, path }, 'Failed to write file');
      throw new Error(`Failed to write ${path}: ${(err as Error).message}`);
    }
  }

  /**
   * List files in a directory.
   * @param recursive - If true, list files recursively
   */
  async listDirectory(path: string, recursive?: boolean): Promise<string[]> {
    try {
      const entries = await readdir(path, { recursive: recursive ?? false });
      const result = entries.map((e) => String(e));
      logger.debug({ path, count: result.length, recursive }, 'Directory listed');
      return result;
    } catch (err) {
      logger.error({ err, path }, 'Failed to list directory');
      throw new Error(`Failed to list ${path}: ${(err as Error).message}`);
    }
  }

  /**
   * Search for files matching a glob pattern within a directory.
   */
  async searchFiles(directory: string, pattern: string): Promise<string[]> {
    try {
      const results: string[] = [];
      const fullPattern = join(directory, pattern);
      for await (const entry of glob(fullPattern)) {
        results.push(String(entry));
      }
      logger.debug({ directory, pattern, count: results.length }, 'File search completed');
      return results;
    } catch (err) {
      logger.error({ err, directory, pattern }, 'File search failed');
      throw new Error(`File search failed in ${directory}: ${(err as Error).message}`);
    }
  }

  /**
   * Get metadata about a file or directory.
   */
  async getFileInfo(path: string): Promise<{
    size: number;
    created: Date;
    modified: Date;
    isDirectory: boolean;
  }> {
    try {
      const stats = await stat(path);
      return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        isDirectory: stats.isDirectory(),
      };
    } catch (err) {
      logger.error({ err, path }, 'Failed to get file info');
      throw new Error(`Failed to stat ${path}: ${(err as Error).message}`);
    }
  }

  /**
   * Watch a directory for changes. Returns an unsubscribe function.
   */
  watchDirectory(
    path: string,
    callback: (event: string, filename: string) => void
  ): () => void {
    let watcher: FSWatcher;
    try {
      watcher = watch(path, { recursive: true }, (eventType, filename) => {
        callback(eventType, filename ?? '');
      });
      logger.info({ path }, 'Directory watch started');
    } catch (err) {
      logger.error({ err, path }, 'Failed to watch directory');
      throw new Error(`Failed to watch ${path}: ${(err as Error).message}`);
    }

    return () => {
      watcher.close();
      logger.info({ path }, 'Directory watch stopped');
    };
  }

  /**
   * Move (rename) a file.
   */
  async moveFile(src: string, dest: string): Promise<void> {
    try {
      const destDir = dest.substring(0, dest.lastIndexOf('/'));
      if (destDir) await mkdir(destDir, { recursive: true });
      await rename(src, dest);
      logger.debug({ src, dest }, 'File moved');
    } catch (err) {
      logger.error({ err, src, dest }, 'Failed to move file');
      throw new Error(`Failed to move ${src} to ${dest}: ${(err as Error).message}`);
    }
  }

  /**
   * Copy a file to a new location.
   */
  async copyFile(src: string, dest: string): Promise<void> {
    try {
      const destDir = dest.substring(0, dest.lastIndexOf('/'));
      if (destDir) await mkdir(destDir, { recursive: true });
      await fsCopyFile(src, dest);
      logger.debug({ src, dest }, 'File copied');
    } catch (err) {
      logger.error({ err, src, dest }, 'Failed to copy file');
      throw new Error(`Failed to copy ${src} to ${dest}: ${(err as Error).message}`);
    }
  }

  /**
   * Delete a file.
   */
  async deleteFile(path: string): Promise<void> {
    try {
      await unlink(path);
      logger.debug({ path }, 'File deleted');
    } catch (err) {
      logger.error({ err, path }, 'Failed to delete file');
      throw new Error(`Failed to delete ${path}: ${(err as Error).message}`);
    }
  }

  /**
   * Calculate the total size of a directory in bytes.
   */
  async getDirectorySize(path: string): Promise<number> {
    try {
      let totalSize = 0;
      const entries = await readdir(path, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(path, entry.name);
        if (entry.isDirectory()) {
          totalSize += await this.getDirectorySize(fullPath);
        } else if (entry.isFile()) {
          const stats = await stat(fullPath);
          totalSize += stats.size;
        }
      }

      logger.debug({ path, totalSize }, 'Directory size calculated');
      return totalSize;
    } catch (err) {
      logger.error({ err, path }, 'Failed to get directory size');
      throw new Error(`Failed to get size of ${path}: ${(err as Error).message}`);
    }
  }
}
