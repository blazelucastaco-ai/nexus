import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('Spotlight');

/**
 * Search using macOS Spotlight (mdfind).
 * @param query - The Spotlight query string
 * @param limit - Maximum number of results (default 20)
 */
export async function spotlightSearch(
  query: string,
  limit?: number
): Promise<Array<{ path: string; name: string; kind: string }>> {
  const maxResults = limit ?? 20;

  try {
    // Get paths matching the query
    const { stdout } = await execFileAsync('mdfind', [query]);
    const paths = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, maxResults);

    if (paths.length === 0) {
      logger.debug({ query }, 'Spotlight search returned no results');
      return [];
    }

    // Get metadata for each result
    const results: Array<{ path: string; name: string; kind: string }> = [];

    for (const filePath of paths) {
      try {
        const { stdout: mdOutput } = await execFileAsync('mdls', [
          '-name', 'kMDItemDisplayName',
          '-name', 'kMDItemKind',
          '-raw',
          filePath,
        ]);

        const lines = mdOutput.split('\0');
        const name = lines[0]?.replace('(null)', '').trim() || filePath.split('/').pop() || '';
        const kind = lines[1]?.replace('(null)', '').trim() || 'Unknown';

        results.push({ path: filePath, name, kind });
      } catch {
        // If mdls fails for a specific file, still include it with basic info
        results.push({
          path: filePath,
          name: filePath.split('/').pop() || '',
          kind: 'Unknown',
        });
      }
    }

    logger.debug({ query, count: results.length }, 'Spotlight search completed');
    return results;
  } catch (err) {
    logger.error({ err, query }, 'Spotlight search failed');
    throw new Error(`Spotlight search failed: ${(err as Error).message}`);
  }
}

/**
 * Find files by name using Spotlight.
 * @param name - The filename to search for
 */
export async function findFileByName(name: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('mdfind', ['-name', name]);
    const paths = stdout.trim().split('\n').filter(Boolean);
    logger.debug({ name, count: paths.length }, 'File name search completed');
    return paths;
  } catch (err) {
    logger.error({ err, name }, 'File name search failed');
    throw new Error(`File name search failed: ${(err as Error).message}`);
  }
}

/**
 * Find files containing specific content using Spotlight.
 * @param content - The text content to search for
 */
export async function findFileByContent(content: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('mdfind', [content]);
    const paths = stdout.trim().split('\n').filter(Boolean);
    logger.debug({ content: content.substring(0, 50), count: paths.length }, 'Content search completed');
    return paths;
  } catch (err) {
    logger.error({ err, content: content.substring(0, 50) }, 'Content search failed');
    throw new Error(`Content search failed: ${(err as Error).message}`);
  }
}
