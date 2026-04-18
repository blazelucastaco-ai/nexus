import { describe, it, expect } from 'vitest';
import { toolDefinitions, toOpenAITools } from '../src/tools/definitions.js';

/**
 * Regression tests for the three previously-unexposed browser tools
 * (switch_tab, select, clear) and for the tightened descriptions on the
 * URL-touching tools (web_search / web_fetch / crawl_url / browser_navigate).
 */

function getTool(name: string) {
  return toolDefinitions.find((t) => t.name === name);
}

describe('newly-exposed browser tools', () => {
  it('browser_switch_tab is registered with a tabId parameter', () => {
    const t = getTool('browser_switch_tab');
    expect(t).toBeDefined();
    expect(t!.parameters.required).toContain('tabId');
    expect(t!.description).toMatch(/browser_get_tabs/i);
  });

  it('browser_select is registered with selector + value', () => {
    const t = getTool('browser_select');
    expect(t).toBeDefined();
    expect(t!.parameters.required).toEqual(expect.arrayContaining(['selector', 'value']));
    expect(t!.description).toMatch(/<select>/);
  });

  it('browser_clear is registered, selector optional', () => {
    const t = getTool('browser_clear');
    expect(t).toBeDefined();
    expect(t!.parameters.required).toEqual([]);
    expect(t!.description).toMatch(/controlled/i); // mentions React/Vue controlled inputs
  });

  it('all three appear in the OpenAI-formatted tool list', () => {
    const names = toOpenAITools().map((t) => t.function.name);
    expect(names).toContain('browser_switch_tab');
    expect(names).toContain('browser_select');
    expect(names).toContain('browser_clear');
  });
});

describe('URL-touching tool descriptions are disambiguated', () => {
  it('web_search explicitly forbids passing a URL as query', () => {
    const t = getTool('web_search');
    expect(t!.description).toMatch(/NEVER pass a URL/i);
    expect(t!.description).toMatch(/browser_navigate/);
  });

  it('web_fetch explicitly points to crawl_url for articles and browser_navigate for SPAs', () => {
    const t = getTool('web_fetch');
    expect(t!.description).toMatch(/crawl_url/);
    expect(t!.description).toMatch(/browser_navigate/);
  });

  it('crawl_url explicitly forbids passing a search query', () => {
    const t = getTool('crawl_url');
    expect(t!.description).toMatch(/search query/i);
    expect(t!.description).toMatch(/web_search/);
  });

  it('browser_navigate explicitly covers the "visit/open a page" case', () => {
    const t = getTool('browser_navigate');
    expect(t!.description).toMatch(/VISIT or OPEN/i);
    expect(t!.description).toMatch(/JS-heavy|SPA|auth/i);
  });
});
