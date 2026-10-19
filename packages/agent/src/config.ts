import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_DEFAULT_PORT } from '@flowforge/core';

export interface AgentConfig {
  port: number;
  token: string;
  ffmpeg: string;
  ffprobe: string;
}

export const CONFIG_DIR = process.env.FLOWFORGE_HOME ?? join(homedir(), '.flowforge');
const FILE = join(CONFIG_DIR, 'agent.json');

/** Loads ~/.flowforge/agent.json, creating it (with a fresh pairing token) on first run. */
export function loadConfig(): AgentConfig {
  let cfg: Partial<AgentConfig> = {};
  if (existsSync(FILE)) {
    try {
      cfg = JSON.parse(readFileSync(FILE, 'utf8'));
    } catch {
      cfg = {};
    }
  }
  const full: AgentConfig = {
    port: Number(process.env.FLOWFORGE_PORT ?? cfg.port ?? BRIDGE_DEFAULT_PORT),
    token: cfg.token || randomBytes(24).toString('base64url'),
    ffmpeg: process.env.FFMPEG_PATH ?? cfg.ffmpeg ?? 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH ?? cfg.ffprobe ?? 'ffprobe',
  };
  if (!cfg.token || cfg.port !== full.port) saveConfig(full);
  return full;
}

export function saveConfig(cfg: AgentConfig) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function rotateToken(): AgentConfig {
  const cfg = loadConfig();
  cfg.token = randomBytes(24).toString('base64url');
  saveConfig(cfg);
  return cfg;
}
