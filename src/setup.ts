#!/usr/bin/env node

/**
 * Interactive setup wizard for mcp-excalidraw-local.
 * Runs via: npx @sanjibdevnath/mcp-excalidraw-local setup
 *
 * Uses only Node.js built-ins — no third-party dependencies.
 * Every phase is optional and skippable.
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Helpers ──────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function ok(msg: string) { process.stdout.write(`    ${GREEN}✔${RESET} ${msg}\n`); }
function fail(msg: string) { process.stdout.write(`    ${RED}✘${RESET} ${msg}\n`); }
function warn(msg: string) { process.stdout.write(`    ${YELLOW}⚠${RESET} ${msg}\n`); }
function info(msg: string) { process.stdout.write(`    ${msg}\n`); }
function heading(phase: string, title: string) {
  process.stdout.write(`\n  ${BOLD}[${phase}] ${title}${RESET}\n`);
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(`  ${prompt}`, resolve));
}

async function confirm(rl: readline.Interface, prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await ask(rl, `${prompt} ${hint}: `)).trim().toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}

// ── Agent Definitions ────────────────────────────────────────

interface AgentDef {
  name: string;
  detectPaths: string[];
  skillBasePaths: { global: string; local: string };
  mcpConfigType: 'json-file' | 'cli-command';
  mcpConfigPath?: string;
  mcpCliCommand?: string;
}

function getAgents(): AgentDef[] {
  const home = os.homedir();
  return [
    {
      name: 'Cursor',
      detectPaths: [path.join(home, '.cursor')],
      skillBasePaths: {
        global: path.join(home, '.cursor', 'skills'),
        local: path.join(process.cwd(), '.cursor', 'skills'),
      },
      mcpConfigType: 'json-file',
      mcpConfigPath: path.join(home, '.cursor', 'mcp.json'),
    },
    {
      name: 'Claude Code',
      detectPaths: [path.join(home, '.claude')],
      skillBasePaths: {
        global: path.join(home, '.claude', 'skills'),
        local: path.join(process.cwd(), '.claude', 'skills'),
      },
      mcpConfigType: 'cli-command',
      mcpCliCommand: 'claude mcp add excalidraw-canvas --scope user -e CANVAS_PORT=3000 -- npx -y @sanjibdevnath/mcp-excalidraw-local',
    },
    {
      name: 'Codex CLI',
      detectPaths: [path.join(home, '.codex')],
      skillBasePaths: {
        global: path.join(home, '.codex', 'skills'),
        local: path.join(process.cwd(), '.codex', 'skills'),
      },
      mcpConfigType: 'json-file',
      mcpConfigPath: path.join(home, '.codex', 'mcp.json'),
    },
  ];
}

function detectInstalledAgents(): AgentDef[] {
  return getAgents().filter(a => a.detectPaths.some(p => fs.existsSync(p)));
}

// ── Phase 1: Environment Check ──────────────────────────────

async function phaseEnvironment(rl: readline.Interface): Promise<boolean> {
  heading('1/3', 'Environment');
  let allOk = true;

  // Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10);
  if (major >= 20) {
    ok(`Node.js ${nodeVersion} ${'.' .repeat(Math.max(0, 24 - nodeVersion.length))} OK`);
  } else {
    fail(`Node.js ${nodeVersion} — requires >= 20.0.0`);
    allOk = false;
  }

  // better-sqlite3 bindings
  try {
    execSync('node -e "require(\'better-sqlite3\')"', { stdio: 'pipe', cwd: path.resolve(__dirname, '..') });
    ok('better-sqlite3 bindings ........... OK');
  } catch {
    fail('better-sqlite3 bindings ........... FAILED');
    const doFix = await confirm(rl, 'Native module needs rebuild. Fix now?');
    if (doFix) {
      try {
        info(`${DIM}Running npm rebuild better-sqlite3...${RESET}`);
        execSync('npm rebuild better-sqlite3', {
          stdio: 'inherit',
          cwd: path.resolve(__dirname, '..'),
        });
        // Verify
        execSync('node -e "require(\'better-sqlite3\')"', { stdio: 'pipe', cwd: path.resolve(__dirname, '..') });
        ok('Rebuild successful');
      } catch {
        fail('Rebuild failed. Try manually:');
        info('  npm rebuild better-sqlite3');
        info('');
        info('Prerequisites:');
        if (process.platform === 'darwin') {
          info('  xcode-select --install');
        } else if (process.platform === 'linux') {
          info('  sudo apt install build-essential python3');
        } else {
          info('  Install "Desktop development with C++" from Visual Studio Build Tools');
          info('  https://visualstudio.microsoft.com/visual-cpp-build-tools/');
        }
        allOk = false;
      }
    } else {
      info('Manual fix: npm rebuild better-sqlite3');
      allOk = false;
    }
  }

  // Frontend build
  const frontendIndex = path.resolve(__dirname, '..', 'dist', 'frontend', 'index.html');
  if (fs.existsSync(frontendIndex)) {
    ok('Frontend build .................... OK');
  } else {
    warn('Frontend build .................... NOT FOUND');
    info(`Expected: ${frontendIndex}`);
    info('Run: npm run build');
  }

  return allOk;
}

// ── Phase 2: Skill Installation ─────────────────────────────

async function phaseSkillInstall(rl: readline.Interface): Promise<void> {
  heading('2/3', 'Agent Skill');

  const wantSkill = await confirm(rl, 'Install the Excalidraw agent skill?');
  if (!wantSkill) {
    info(`${DIM}Skill folder: skills/excalidraw-skill/ (copy manually if needed)${RESET}`);
    return;
  }

  const agents = detectInstalledAgents();
  if (agents.length === 0) {
    warn('No supported agents detected (Cursor, Claude Code, Codex CLI).');
    info(`${DIM}Skill folder: skills/excalidraw-skill/ (copy manually when ready)${RESET}`);
    return;
  }

  process.stdout.write('\n  Detected agents:\n');
  agents.forEach((a, i) => {
    process.stdout.write(`    ${CYAN}[${i + 1}]${RESET} ${a.name}\n`);
  });

  const selection = await ask(rl, "Which agents? (comma-separated, 'all', or 'skip'): ");
  const trimmed = selection.trim().toLowerCase();

  if (trimmed === 'skip' || trimmed === '') return;

  let selectedAgents: AgentDef[];
  if (trimmed === 'all') {
    selectedAgents = agents;
  } else {
    const indices = trimmed.split(',').map(s => parseInt(s.trim(), 10) - 1);
    selectedAgents = indices
      .filter(i => i >= 0 && i < agents.length)
      .map(i => agents[i]!);
  }

  if (selectedAgents.length === 0) {
    warn('No valid agents selected.');
    return;
  }

  const skillSource = path.resolve(__dirname, '..', 'skills', 'excalidraw-skill');
  if (!fs.existsSync(skillSource)) {
    fail(`Skill source not found at ${skillSource}`);
    return;
  }

  for (const agent of selectedAgents) {
    const scopeAnswer = await ask(rl, `\n  ${agent.name} — scope? [G]lobal / [l]ocal: `);
    const scope = scopeAnswer.trim().toLowerCase() === 'l' ? 'local' : 'global';
    const destBase = agent.skillBasePaths[scope];
    const destDir = path.join(destBase, 'excalidraw-skill');

    try {
      fs.mkdirSync(destDir, { recursive: true });
      copyDirSync(skillSource, destDir);
      ok(`Installed to ${destDir}`);
    } catch (err) {
      fail(`Failed to install to ${destDir}: ${(err as Error).message}`);
    }
  }
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── Phase 3: MCP Configuration ──────────────────────────────

async function phaseMcpConfig(rl: readline.Interface): Promise<void> {
  heading('3/3', 'MCP Configuration');

  const wantConfig = await confirm(rl, 'Add MCP server to agent configs automatically?');
  if (!wantConfig) {
    printManualConfig();
    return;
  }

  const agents = detectInstalledAgents();
  if (agents.length === 0) {
    warn('No supported agents detected.');
    printManualConfig();
    return;
  }

  for (const agent of agents) {
    if (agent.mcpConfigType === 'json-file' && agent.mcpConfigPath) {
      const doIt = await confirm(rl, `${agent.name} — add to ${agent.mcpConfigPath}?`);
      if (!doIt) {
        info(`${DIM}Skipped. Add manually later.${RESET}`);
        continue;
      }

      try {
        mergeJsonConfig(agent.mcpConfigPath);
        ok(`Added 'excalidraw-canvas' to ${agent.mcpConfigPath}`);
      } catch (err) {
        fail(`Failed: ${(err as Error).message}`);
        info('Add manually:');
        printManualConfig();
      }
    } else if (agent.mcpConfigType === 'cli-command' && agent.mcpCliCommand) {
      const doIt = await confirm(rl, `${agent.name} — register via CLI?`);
      if (!doIt) {
        info(`${DIM}Skipped.${RESET}`);
        continue;
      }

      try {
        execSync(agent.mcpCliCommand, { stdio: 'inherit' });
        ok(`Registered 'excalidraw-canvas' via ${agent.name} CLI`);
      } catch (err) {
        fail(`CLI registration failed: ${(err as Error).message}`);
        info('Register manually:');
        info(`  ${agent.mcpCliCommand}`);
      }
    }
  }
}

function mergeJsonConfig(configPath: string): void {
  const mcpEntry = {
    command: 'npx',
    args: ['-y', '@sanjibdevnath/mcp-excalidraw-local'],
    env: { CANVAS_PORT: '3000' },
  };

  let existing: any = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    try {
      existing = JSON.parse(raw);
    } catch {
      throw new Error(`Failed to parse ${configPath} — fix the JSON syntax and try again.`);
    }
  }

  if (!existing.mcpServers) {
    existing.mcpServers = {};
  }

  if (existing.mcpServers['excalidraw-canvas']) {
    process.stdout.write(`    ${YELLOW}Entry 'excalidraw-canvas' already exists — overwriting.${RESET}\n`);
  }

  existing.mcpServers['excalidraw-canvas'] = mcpEntry;

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
}

function printManualConfig(): void {
  process.stdout.write(`
    Manual config (JSON):
    ${DIM}{
      "mcpServers": {
        "excalidraw-canvas": {
          "command": "npx",
          "args": ["-y", "@sanjibdevnath/mcp-excalidraw-local"],
          "env": { "CANVAS_PORT": "3000" }
        }
      }
    }${RESET}
`);
}

// ── Update ───────────────────────────────────────────────────

interface SkillInstallation {
  agent: AgentDef;
  scope: 'global' | 'local';
  path: string;
  exists: boolean;
}

function getPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function findExistingSkillInstalls(): SkillInstallation[] {
  const agents = getAgents();
  const installs: SkillInstallation[] = [];
  for (const agent of agents) {
    for (const scope of ['global', 'local'] as const) {
      const skillDir = path.join(agent.skillBasePaths[scope], 'excalidraw-skill');
      installs.push({
        agent,
        scope,
        path: skillDir,
        exists: fs.existsSync(path.join(skillDir, 'SKILL.md')),
      });
    }
  }
  return installs;
}

export async function runUpdate(): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write('Error: Update requires an interactive terminal.\n');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const version = getPackageVersion();
  process.stdout.write(`\n  ${BOLD}Excalidraw MCP — Update${RESET}  ${DIM}v${version}${RESET}\n`);

  try {
    // ── Phase 1: Detect existing skill installations ──────────
    heading('1/2', 'Skill Update');

    const allInstalls = findExistingSkillInstalls();
    const existing = allInstalls.filter(i => i.exists);
    const missing = allInstalls.filter(i => !i.exists);
    const detectedAgents = detectInstalledAgents();

    const skillSource = path.resolve(__dirname, '..', 'skills', 'excalidraw-skill');
    if (!fs.existsSync(skillSource)) {
      fail(`Skill source not found at ${skillSource}`);
      fail('This can happen with corrupted installs. Try: npx @sanjibdevnath/mcp-excalidraw-local@latest setup');
      rl.close();
      return;
    }

    if (existing.length > 0) {
      process.stdout.write(`\n  Found ${CYAN}${existing.length}${RESET} existing skill installation(s):\n`);
      existing.forEach((inst, i) => {
        const label = `${inst.agent.name} (${inst.scope})`;
        process.stdout.write(`    ${CYAN}[${i + 1}]${RESET} ${label} — ${DIM}${inst.path}${RESET}\n`);
      });

      const doUpdate = await confirm(rl, `\n  Update all ${existing.length} installation(s) to v${version}?`);
      if (doUpdate) {
        let updated = 0;
        for (const inst of existing) {
          try {
            copyDirSync(skillSource, inst.path);
            ok(`Updated ${inst.agent.name} (${inst.scope}) — ${inst.path}`);
            updated++;
          } catch (err) {
            fail(`Failed to update ${inst.path}: ${(err as Error).message}`);
          }
        }
        process.stdout.write(`\n    ${GREEN}${updated}/${existing.length}${RESET} skill(s) updated.\n`);
      } else {
        info(`${DIM}Skipped skill update.${RESET}`);
      }
    } else {
      info('No existing skill installations found.');
    }

    // Offer to install for detected agents that don't have the skill
    const agentsWithoutSkill = detectedAgents.filter(agent =>
      !existing.some(inst => inst.agent.name === agent.name),
    );

    if (agentsWithoutSkill.length > 0) {
      process.stdout.write(`\n  Agents without the skill:\n`);
      agentsWithoutSkill.forEach((a, i) => {
        process.stdout.write(`    ${YELLOW}[${i + 1}]${RESET} ${a.name}\n`);
      });

      const doInstall = await confirm(rl, 'Install the skill for these agents?');
      if (doInstall) {
        for (const agent of agentsWithoutSkill) {
          const scopeAnswer = await ask(rl, `\n  ${agent.name} — scope? [G]lobal / [l]ocal: `);
          const scope = scopeAnswer.trim().toLowerCase() === 'l' ? 'local' : 'global';
          const destDir = path.join(agent.skillBasePaths[scope], 'excalidraw-skill');

          try {
            fs.mkdirSync(destDir, { recursive: true });
            copyDirSync(skillSource, destDir);
            ok(`Installed to ${destDir}`);
          } catch (err) {
            fail(`Failed to install to ${destDir}: ${(err as Error).message}`);
          }
        }
      }
    }

    // ── Phase 2: MCP config check ────────────────────────────
    heading('2/2', 'MCP Configuration');

    const wantConfig = await confirm(rl, 'Re-apply MCP server config? (overwrites existing entry)', false);
    if (wantConfig) {
      for (const agent of detectedAgents) {
        if (agent.mcpConfigType === 'json-file' && agent.mcpConfigPath) {
          const doIt = await confirm(rl, `${agent.name} — update ${agent.mcpConfigPath}?`);
          if (doIt) {
            try {
              mergeJsonConfig(agent.mcpConfigPath);
              ok(`Updated 'excalidraw-canvas' in ${agent.mcpConfigPath}`);
            } catch (err) {
              fail(`Failed: ${(err as Error).message}`);
            }
          }
        } else if (agent.mcpConfigType === 'cli-command' && agent.mcpCliCommand) {
          const doIt = await confirm(rl, `${agent.name} — re-register via CLI?`);
          if (doIt) {
            try {
              execSync(agent.mcpCliCommand, { stdio: 'inherit' });
              ok(`Re-registered 'excalidraw-canvas' via ${agent.name} CLI`);
            } catch (err) {
              fail(`CLI registration failed: ${(err as Error).message}`);
            }
          }
        }
      }
    } else {
      info(`${DIM}MCP config unchanged.${RESET}`);
    }

    process.stdout.write(`\n  ${GREEN}${BOLD}Update complete!${RESET} Restart your MCP client to pick up changes.\n\n`);
  } finally {
    rl.close();
  }
}

// ── Main ─────────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write('Error: Setup requires an interactive terminal. Run this command directly in your terminal (not piped or in CI).\n');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  process.stdout.write(`\n  ${BOLD}Excalidraw MCP — Setup${RESET}\n`);

  try {
    await phaseEnvironment(rl);
    await phaseSkillInstall(rl);
    await phaseMcpConfig(rl);

    process.stdout.write(`\n  ${GREEN}${BOLD}Done!${RESET} Open ${CYAN}http://localhost:3000${RESET} to verify the canvas.\n\n`);
  } finally {
    rl.close();
  }
}
