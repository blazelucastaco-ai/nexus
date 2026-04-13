#!/usr/bin/env tsx
/**
 * NEXUS Browser Stress Test
 * ─────────────────────────
 * Deep end-to-end test of browser automation: navigation, form filling,
 * SPA routing, multi-tab, sign-ups, interactions, infinite scroll, and recovery.
 *
 * Usage:
 *   pnpm tsx scripts/browser-stress-test.ts
 *   pnpm tsx scripts/browser-stress-test.ts --category A
 *   pnpm tsx scripts/browser-stress-test.ts --test "HackerNews top stories"
 */

import 'dotenv/config';
import chalk from 'chalk';
import { loadConfig } from '../src/config.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { MemoryManager } from '../src/memory/index.js';
import { MemoryCortex } from '../src/memory/cortex.js';
import { closeDatabase } from '../src/memory/database.js';
import { PersonalityEngine } from '../src/personality/index.js';
import { AgentManager } from '../src/agents/index.js';
import { AIManager } from '../src/ai/index.js';
import { MacOSController } from '../src/macos/index.js';
import { LearningSystem } from '../src/learning/index.js';
import { browserBridge } from '../src/browser/bridge.js';
import type { TelegramGateway } from '../src/telegram/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TestCase {
  id: string;
  category: string;
  name: string;
  prompt: string;
  expectedKeywords?: string[];
  expectSuccess?: boolean;
}

interface TestResult {
  id: string;
  name: string;
  category: string;
  passed: boolean;
  response: string;
  durationMs: number;
  error?: string;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

const TESTS: TestCase[] = [

  // ── A: Basic Navigation & Extraction ─────────────────────────────────────
  {
    id: 'A1',
    category: 'A',
    name: 'HTTPBin headers',
    prompt: 'Navigate to https://httpbin.org/headers and tell me what headers the page shows.',
    expectedKeywords: ['Host', 'User-Agent'],
  },
  {
    id: 'A2',
    category: 'A',
    name: 'HTTPBin IP address',
    prompt: 'Go to https://httpbin.org/ip and tell me the origin IP address shown.',
    expectedKeywords: ['origin'],
  },
  {
    id: 'A3',
    category: 'A',
    name: 'Wikipedia page extraction',
    prompt: 'Navigate to https://en.wikipedia.org/wiki/TypeScript and extract the first paragraph of the article.',
    expectedKeywords: ['TypeScript', 'JavaScript', 'Microsoft'],
  },
  {
    id: 'A4',
    category: 'A',
    name: 'Hacker News front page',
    prompt: 'Go to https://news.ycombinator.com and list the top 5 story titles.',
    expectedKeywords: ['Show HN', 'Ask HN'],
  },
  {
    id: 'A5',
    category: 'A',
    name: 'GitHub trending repos',
    prompt: 'Navigate to https://github.com/trending and list the first 3 trending repositories with their descriptions.',
    expectedKeywords: ['stars', 'repo'],
  },
  {
    id: 'A6',
    category: 'A',
    name: 'Links extraction',
    prompt: 'Go to https://example.com and list all the links on the page.',
    expectedKeywords: ['iana.org'],
  },
  {
    id: 'A7',
    category: 'A',
    name: 'Page headings extraction',
    prompt: 'Navigate to https://en.wikipedia.org/wiki/JavaScript and list the first 5 section headings.',
    expectedKeywords: ['History', 'JavaScript'],
  },
  {
    id: 'A8',
    category: 'A',
    name: 'Quotes site scraping',
    prompt: 'Navigate to https://quotes.toscrape.com and list the first 3 quotes with their authors.',
    expectedKeywords: ['—', 'Albert Einstein', 'quote'],
  },

  // ── B: Form Interactions ──────────────────────────────────────────────────
  {
    id: 'B1',
    category: 'B',
    name: 'Simple form fill and submit',
    prompt: 'Navigate to https://httpbin.org/forms/post and fill out the form: customer="TestUser", custtel="555-1234", custemail="test@example.com", size="medium", then submit it. Report what response you get.',
    expectedKeywords: ['TestUser', 'custtel', '555'],
  },
  {
    id: 'B2',
    category: 'B',
    name: 'Search field interaction',
    prompt: 'Navigate to https://duckduckgo.com and search for "TypeScript tutorial 2025". List the first 3 result titles you can see.',
    expectedKeywords: ['TypeScript'],
  },
  {
    id: 'B3',
    category: 'B',
    name: 'Form field discovery',
    prompt: 'Navigate to https://the-internet.herokuapp.com/login and use browser_extract with mode=form to discover the form fields. Then fill: username="tomsmith", password="SuperSecretPassword!", and click Login. Report the result.',
    expectedKeywords: ['secure', 'logged in', 'success'],
  },
  {
    id: 'B4',
    category: 'B',
    name: 'Dropdown selection',
    prompt: 'Navigate to https://the-internet.herokuapp.com/dropdown and select "Option 2" from the dropdown. Confirm it was selected.',
    expectedKeywords: ['Option 2'],
  },
  {
    id: 'B5',
    category: 'B',
    name: 'Checkbox interactions',
    prompt: 'Navigate to https://the-internet.herokuapp.com/checkboxes and check both checkboxes. Report their states.',
    expectedKeywords: ['checkbox', 'checked'],
  },
  {
    id: 'B6',
    category: 'B',
    name: 'Input with Enter key submit',
    prompt: 'Navigate to https://the-internet.herokuapp.com/inputs and type the number 42 in the input field, then press Enter. Tell me what you see.',
    expectedKeywords: ['42', 'input'],
  },
  {
    id: 'B7',
    category: 'B',
    name: 'Multi-field form',
    prompt: 'Navigate to https://demoqa.com/text-box and fill the form: Full Name="John Smith", Email="john@example.com", Current Address="123 Main St", Permanent Address="456 Oak Ave". Click Submit and report the output section.',
    expectedKeywords: ['John Smith', 'john@example.com', '123 Main St'],
  },

  // ── C: SPA Navigation ────────────────────────────────────────────────────
  {
    id: 'C1',
    category: 'C',
    name: 'React TodoMVC — add and complete todo',
    prompt: 'Navigate to https://todomvc.com/examples/react/dist/ and: 1) Add a todo item "Buy groceries", 2) Add another "Walk the dog", 3) Click on "Walk the dog" to mark it complete. Report the todo list state.',
    expectedKeywords: ['Buy groceries', 'Walk the dog'],
  },
  {
    id: 'C2',
    category: 'C',
    name: 'SPA hash routing',
    prompt: 'Navigate to https://the-internet.herokuapp.com/dynamic_loading/1 and click the Start button. Wait for the text to appear and report what it says.',
    expectedKeywords: ['Hello World', 'hello'],
  },
  {
    id: 'C3',
    category: 'C',
    name: 'JavaScript alerts',
    prompt: 'Navigate to https://the-internet.herokuapp.com/javascript_alerts and click the "Click for JS Alert" button. Report what happens.',
    expectedKeywords: ['alert', 'JS Alert'],
  },
  {
    id: 'C4',
    category: 'C',
    name: 'Hover dropdown menu',
    prompt: 'Navigate to https://the-internet.herokuapp.com/hovers and hover over the first user image. Report what text appears.',
    expectedKeywords: ['View profile', 'user'],
  },
  {
    id: 'C5',
    category: 'C',
    name: 'GitHub explore filtering',
    prompt: 'Navigate to https://github.com/explore and extract the page text to see what trending repositories or topics are shown. List 3 items.',
    expectedKeywords: ['GitHub', 'repository', 'star'],
  },

  // ── D: Multi-Tab Workflows ────────────────────────────────────────────────
  {
    id: 'D1',
    category: 'D',
    name: 'Open link in new tab',
    prompt: 'Open a new tab and navigate it to https://example.com. Then tell me how many tabs are currently open and what the new tab shows.',
    expectedKeywords: ['Example Domain', 'tab'],
  },
  {
    id: 'D2',
    category: 'D',
    name: 'Multi-tab comparison',
    prompt: 'Open two new tabs: one to https://example.com and one to https://httpbin.org. List all open tabs by title.',
    expectedKeywords: ['Example Domain', 'httpbin'],
  },
  {
    id: 'D3',
    category: 'D',
    name: 'Tab switching',
    prompt: 'Open a new tab to https://news.ycombinator.com. Then switch back to the first tab. Report the current tab URL.',
    expectedKeywords: ['tab', 'URL'],
  },

  // ── E: Cookie Banners & Real-World Sites ──────────────────────────────────
  {
    id: 'E1',
    category: 'E',
    name: 'Cookie banner dismissal — Wikipedia',
    prompt: 'Navigate to https://www.wikipedia.org and try to dismiss any cookie banner. Then extract the main page content and list the top 3 featured languages.',
    expectedKeywords: ['English', 'Wikipedia'],
  },
  {
    id: 'E2',
    category: 'E',
    name: 'BBC News navigation',
    prompt: 'Navigate to https://www.bbc.com/news and dismiss any cookie banner. Extract the first 3 headline titles.',
    expectedKeywords: ['BBC'],
  },
  {
    id: 'E3',
    category: 'E',
    name: 'Reddit content extraction',
    prompt: 'Navigate to https://www.reddit.com/r/programming/ and extract the top 5 post titles.',
    expectedKeywords: ['post', 'programming'],
  },
  {
    id: 'E4',
    category: 'E',
    name: 'GuerrillaMail temp email',
    prompt: 'Navigate to https://www.guerrillamail.com and extract the temporary email address shown. Do not interact with anything else.',
    expectedKeywords: ['@guerrillamail', '@sharklasers', 'email', '@'],
  },
  {
    id: 'E5',
    category: 'E',
    name: 'Dev.to article listing',
    prompt: 'Navigate to https://dev.to and extract the titles of the first 5 articles shown.',
    expectedKeywords: ['dev.to', '#'],
  },

  // ── F: Complex Web Apps ───────────────────────────────────────────────────
  {
    id: 'F1',
    category: 'F',
    name: 'GitHub repo search',
    prompt: 'Navigate to https://github.com/search?q=typescript+framework&type=repositories and extract the first 3 repository names and star counts.',
    expectedKeywords: ['stars', 'typescript'],
  },
  {
    id: 'F2',
    category: 'F',
    name: 'GitHub profile reading',
    prompt: 'Navigate to https://github.com/microsoft and extract the organization bio and number of public repositories.',
    expectedKeywords: ['Microsoft', 'repositories'],
  },
  {
    id: 'F3',
    category: 'F',
    name: 'CodePen trending',
    prompt: 'Navigate to https://codepen.io/trending and extract the titles of the first 3 trending pens.',
    expectedKeywords: ['CodePen', 'pen'],
  },
  {
    id: 'F4',
    category: 'F',
    name: 'NPM package info',
    prompt: 'Navigate to https://www.npmjs.com/package/typescript and extract the latest version number and weekly download count.',
    expectedKeywords: ['typescript', 'version', 'weekly'],
  },
  {
    id: 'F5',
    category: 'F',
    name: 'Stack Overflow question',
    prompt: 'Navigate to https://stackoverflow.com/questions and extract the titles of the top 3 newest questions.',
    expectedKeywords: ['question', 'Stack Overflow'],
  },
  {
    id: 'F6',
    category: 'F',
    name: 'MDN docs lookup',
    prompt: 'Navigate to https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map and extract the first paragraph of the description.',
    expectedKeywords: ['Array', 'map', 'returns', 'function'],
  },

  // ── G: Dynamic Content & Infinite Scroll ──────────────────────────────────
  {
    id: 'G1',
    category: 'G',
    name: 'Infinite scroll — load more',
    prompt: 'Navigate to https://the-internet.herokuapp.com/infinite_scroll and scroll down 3 times (1000px each). Extract how many paragraphs are now visible.',
    expectedKeywords: ['paragraph', 'Pellentesque'],
  },
  {
    id: 'G2',
    category: 'G',
    name: 'Dynamic table data',
    prompt: 'Navigate to https://the-internet.herokuapp.com/tables and extract the data from the first table, listing all rows.',
    expectedKeywords: ['Last Name', 'First Name', 'Email'],
  },
  {
    id: 'G3',
    category: 'G',
    name: 'Lazy loaded images',
    prompt: 'Navigate to https://the-internet.herokuapp.com/large and scroll to the bottom of the page. Report how many images you can find on the page.',
    expectedKeywords: ['image', 'img'],
  },
  {
    id: 'G4',
    category: 'G',
    name: 'Live search with autocomplete',
    prompt: 'Navigate to https://the-internet.herokuapp.com/typos and read the page content. Report any typos you notice in the text.',
    expectedKeywords: ['typo'],
  },
  {
    id: 'G5',
    category: 'G',
    name: 'Product Hunt today',
    prompt: 'Navigate to https://www.producthunt.com/ and extract the top 3 products listed.',
    expectedKeywords: ['Product Hunt', 'upvote'],
  },

  // ── H: Error Recovery & Edge Cases ────────────────────────────────────────
  {
    id: 'H1',
    category: 'H',
    name: '404 page handling',
    prompt: 'Navigate to https://httpbin.org/status/404 and report what the page says.',
    expectedKeywords: ['404', 'NOT FOUND', 'status'],
  },
  {
    id: 'H2',
    category: 'H',
    name: 'Redirect following',
    prompt: 'Navigate to https://httpbin.org/redirect/3 and report the final URL you land on.',
    expectedKeywords: ['httpbin.org', 'final', 'URL'],
  },
  {
    id: 'H3',
    category: 'H',
    name: 'Non-existent element graceful fail',
    prompt: 'Navigate to https://example.com. Try to click a button with selector "#nonexistent-button-xyz". Report what happened gracefully.',
    expectedKeywords: ['not found', 'error', 'failed', 'couldn'],
  },
  {
    id: 'H4',
    category: 'H',
    name: 'Slow page wait_for',
    prompt: 'Navigate to https://the-internet.herokuapp.com/dynamic_loading/2 and click Start. Use browser_wait_for to wait for the element with selector "#finish" to appear (timeout 15000ms). Report what text appears.',
    expectedKeywords: ['Hello World', 'finish'],
  },
  {
    id: 'H5',
    category: 'H',
    name: 'Page with frames/iframes',
    prompt: 'Navigate to https://the-internet.herokuapp.com/frames and list the links and headings available on the page.',
    expectedKeywords: ['frame', 'Frame', 'iFrame'],
  },
  {
    id: 'H6',
    category: 'H',
    name: 'Back/forward navigation',
    prompt: 'Navigate to https://example.com. Then navigate to https://httpbin.org. Then go back in history. Report what page you are on now.',
    expectedKeywords: ['example.com', 'Example Domain'],
  },
  {
    id: 'H7',
    category: 'H',
    name: 'Page reload',
    prompt: 'Navigate to https://httpbin.org/uuid and note the UUID. Reload the page. Does the UUID change? Report both values.',
    expectedKeywords: ['uuid', 'UUID', 'reload'],
  },

  // ── I: Real-World Sign-up Flows ───────────────────────────────────────────
  {
    id: 'I1',
    category: 'I',
    name: 'GuerrillaMail + basic form',
    prompt: `First get a temp email from https://www.guerrillamail.com (extract the email address).
Then navigate to https://the-internet.herokuapp.com/login and login with username="tomsmith", password="SuperSecretPassword!".
Report: 1) The temp email address you got, 2) Whether the login succeeded.`,
    expectedKeywords: ['email', '@', 'logged in', 'secure'],
  },
  {
    id: 'I2',
    category: 'I',
    name: 'Netlify signup page load',
    prompt: 'Navigate to https://app.netlify.com/signup and use browser_extract mode=form to discover the signup form fields. Report what fields are available without filling them.',
    expectedKeywords: ['email', 'name', 'password', 'field'],
  },
  {
    id: 'I3',
    category: 'I',
    name: 'GitHub signup page inspection',
    prompt: 'Navigate to https://github.com/signup and discover all form fields using browser_extract mode=form. List them without filling anything.',
    expectedKeywords: ['email', 'username', 'password', 'field'],
  },

  // ── J: Scroll + Interaction Combos ────────────────────────────────────────
  {
    id: 'J1',
    category: 'J',
    name: 'Scroll to element and click',
    prompt: 'Navigate to https://the-internet.herokuapp.com/large and scroll down 3000 pixels. Then scroll back to top. Report the current scroll position (0 means top).',
    expectedKeywords: ['scroll', 'top', 'page'],
  },
  {
    id: 'J2',
    category: 'J',
    name: 'Multi-step navigation flow',
    prompt: 'Navigate to https://the-internet.herokuapp.com. Click on the "Form Authentication" link. Then log in with username="tomsmith" and password="SuperSecretPassword!". Click Login. Report the result.',
    expectedKeywords: ['secure', 'logged in', 'success'],
  },
  {
    id: 'J3',
    category: 'J',
    name: 'Context menu / right click area',
    prompt: 'Navigate to https://the-internet.herokuapp.com/context_menu and extract the page text. Describe what the page is for.',
    expectedKeywords: ['context', 'right click', 'menu'],
  },
  {
    id: 'J4',
    category: 'J',
    name: 'Drag & drop page inspection',
    prompt: 'Navigate to https://the-internet.herokuapp.com/drag_and_drop and extract the page. Report the two elements available for dragging.',
    expectedKeywords: ['A', 'B', 'drag'],
  },
  {
    id: 'J5',
    category: 'J',
    name: 'File upload page inspection',
    prompt: 'Navigate to https://the-internet.herokuapp.com/upload and use browser_extract mode=form to discover the upload form. Report what fields exist.',
    expectedKeywords: ['file', 'upload', 'input'],
  },
];

// ─── Orchestrator setup ────────────────────────────────────────────────────────

async function initOrchestrator(): Promise<Orchestrator> {
  const config = loadConfig();
  const memory = new MemoryManager(config.memory.maxShortTerm);
  const personality = new PersonalityEngine(config);
  const ai = new AIManager(config.ai.provider);
  const macos = new MacOSController();
  const agents = new AgentManager();
  const cortex = new MemoryCortex();
  cortex.initialize();
  const learning = new LearningSystem(cortex);

  process.once('exit', () => { try { closeDatabase(); } catch {} try { browserBridge.stop(); } catch {} });
  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));

  const stubMessages = new Map<number, string>();
  let stubMsgId = 2000;

  const telegramStub = {
    start: async () => {},
    stop: () => {},
    setOrchestrator: () => {},
    onMessage: () => {},
    sendMessage: async (_: string, text: string) => {
      const plain = text.replace(/<[^>]+>/g, '').trim();
      if (plain) process.stdout.write(chalk.dim('\n  [telegram] ') + chalk.white(plain.slice(0, 200)) + '\n');
    },
    sendStreamingMessage: async (_: string, text: string) => {
      const id = stubMsgId++;
      stubMessages.set(id, text);
      return id;
    },
    editMessage: async (_: string, id: number, text: string) => { stubMessages.set(id, text); },
    finalizeStreamingMessage: async (_: string, id: number, text: string) => {
      stubMessages.set(id, text);
      const plain = text.replace(/<[^>]+>/g, '').trim();
      if (plain) process.stdout.write(chalk.dim('\n  [finalize] ') + chalk.cyan(plain.slice(0, 200)) + '\n');
    },
    sendTypingAction: async () => {},
    sendPhoto: async () => {},
    sendDocument: async () => {},
  } as unknown as TelegramGateway;

  const orchestrator = new Orchestrator();
  orchestrator.init({ memory, personality, agents, ai, telegram: telegramStub, macos, learning });

  // Start browser bridge
  try {
    browserBridge.start();
    await new Promise<void>((resolve) => {
      if (browserBridge.isConnected) { resolve(); return; }
      const t = setTimeout(resolve, 35000);
      browserBridge.onConnect(() => { clearTimeout(t); resolve(); });
    });
  } catch(e) {
    console.log(chalk.red(`  ✗ Browser bridge failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  return orchestrator;
}

// ─── Test runner ───────────────────────────────────────────────────────────────

async function runTest(orchestrator: Orchestrator, test: TestCase): Promise<TestResult> {
  const start = Date.now();
  process.stdout.write(chalk.dim(`  [${test.id}] ${test.name}...`));

  try {
    const response = await orchestrator.processMessage(test.prompt, 'stress-test');
    await orchestrator.waitForPendingTasks();
    const durationMs = Date.now() - start;

    // Check expected keywords
    const lower = response.toLowerCase();
    const allKeywordsFound = !test.expectedKeywords || test.expectedKeywords.length === 0
      || test.expectedKeywords.some(kw => lower.includes(kw.toLowerCase()));

    const passed = allKeywordsFound && !response.includes('Extension not connected');

    if (passed) {
      process.stdout.write(chalk.green(` ✓ ${durationMs}ms\n`));
    } else {
      process.stdout.write(chalk.red(` ✗ ${durationMs}ms\n`));
      if (!allKeywordsFound) {
        process.stdout.write(chalk.dim(`       Missing: ${test.expectedKeywords?.filter(kw => !lower.includes(kw.toLowerCase())).join(', ')}\n`));
      }
    }

    return { id: test.id, name: test.name, category: test.category, passed, response, durationMs };
  } catch(err) {
    const durationMs = Date.now() - start;
    process.stdout.write(chalk.red(` ✗ ERROR ${durationMs}ms\n`));
    return {
      id: test.id, name: test.name, category: test.category,
      passed: false, response: '', durationMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printReport(results: TestResult[]) {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed);
  const total = results.length;
  const avgMs = Math.round(results.reduce((s, r) => s + r.durationMs, 0) / total);

  console.log('');
  console.log(chalk.bold('  ══ STRESS TEST REPORT ══'));
  console.log('');
  console.log(`  ${chalk.green(`✓ ${passed} passed`)}  ${chalk.red(`✗ ${failed.length} failed`)}  ${chalk.dim(`(${total} total, avg ${avgMs}ms)`)}`);
  console.log('');

  // Group by category
  const categories = [...new Set(results.map(r => r.category))].sort();
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const catPassed = catResults.filter(r => r.passed).length;
    console.log(chalk.bold(`  Category ${cat}: ${catPassed}/${catResults.length}`));
    for (const r of catResults) {
      const icon = r.passed ? chalk.green('✓') : chalk.red('✗');
      const dur = chalk.dim(`${r.durationMs}ms`);
      console.log(`    ${icon} [${r.id}] ${r.name} ${dur}`);
      if (!r.passed) {
        if (r.error) {
          console.log(chalk.red(`         Error: ${r.error.slice(0, 150)}`));
        } else {
          console.log(chalk.dim(`         Response: ${r.response.slice(0, 150).replace(/\n/g, ' ')}...`));
        }
      }
    }
    console.log('');
  }

  const score = Math.round((passed / total) * 100);
  const color = score >= 80 ? chalk.green : score >= 60 ? chalk.yellow : chalk.red;
  console.log(`  ${chalk.bold('Score:')} ${color(`${score}%`)}`);
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1]
    ?? (args.includes('--category') ? args[args.indexOf('--category') + 1] : null);
  const testFilter = args.find(a => a.startsWith('--test='))?.split('=')[1]
    ?? (args.includes('--test') ? args.slice(args.indexOf('--test') + 1).join(' ') : null);

  console.log('');
  console.log(chalk.bold.cyan('  ◈ NEXUS Browser Stress Test'));
  console.log(chalk.dim('  ─────────────────────────────────────────────'));
  console.log('');

  console.log(chalk.dim('  Initializing NEXUS...'));
  const orchestrator = await initOrchestrator();

  if (browserBridge.isConnected) {
    console.log(chalk.green('  ✓ Chrome extension connected'));
  } else {
    console.log(chalk.yellow('  ⚠ Chrome extension not connected — browser tests will fail'));
    console.log(chalk.dim('  Open Chrome with NEXUS Bridge loaded, or run: launchctl start com.nexus.ai'));
  }
  console.log('');

  // Filter tests
  let testsToRun = TESTS;
  if (categoryFilter) {
    testsToRun = TESTS.filter(t => t.category === categoryFilter.toUpperCase());
    console.log(chalk.dim(`  Filtered to category ${categoryFilter.toUpperCase()}: ${testsToRun.length} tests`));
  }
  if (testFilter) {
    testsToRun = TESTS.filter(t => t.name.toLowerCase().includes(testFilter.toLowerCase()) || t.id.toLowerCase() === testFilter.toLowerCase());
    console.log(chalk.dim(`  Filtered to "${testFilter}": ${testsToRun.length} tests`));
  }

  console.log(chalk.dim(`  Running ${testsToRun.length} tests...`));
  console.log('');

  const results: TestResult[] = [];
  for (const test of testsToRun) {
    const result = await runTest(orchestrator, test);
    results.push(result);
    // Cooldown between tests to avoid overloading
    await new Promise(r => setTimeout(r, 1500));
  }

  printReport(results);
  process.exit(0);
}

main().catch(err => {
  console.error(chalk.red('Fatal:'), err);
  process.exit(1);
});
