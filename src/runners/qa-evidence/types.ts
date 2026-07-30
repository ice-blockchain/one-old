// src/runners/qa-evidence/types.ts
// Runner shapes: scenario steps/routes, args, the structural Playwright
// surface, and the OwnedServer pair.

import {  type ChildProcess } from 'child_process';
import {  type Server } from 'http';
import * as path from 'path';

export type Rec = Record<string, unknown>;

export interface ScenarioStep {
  type: 'click' | 'fill' | 'press' | 'check' | 'select' | 'expect-visible' | 'expect-text' | 'expect-url';
  selector?: string;
  value?: string;
}

export interface RouteScenario {
  /**
   * The compiled contract's route IDENTITY — `/`, `*`, `/courses/:courseSlug`.
   * Evidence stays indexed by this so a report can be matched back to the
   * architecture.
   */
  route: string;
  /** The concrete URL actually navigated to. Equals `route` when it is literal. */
  startPath: string;
  finalPath: string;
  stableSelector: string;
  steps: ScenarioStep[];
}

export interface ScenarioV1 {
  schemaVersion: 1;
  routes: RouteScenario[];
}

export interface RunnerArgs {
  command: 'manifest' | 'browser' | 'lighthouse' | 'native' | 'stack' | 'help';
  projectRoot: string;
  runId: string;
  buildDir: string;
  scenarioJson?: string;
  scenarioFile?: string;
  serverCommandJson?: string;
  serverCwd?: string;
  nativeCommandJson?: string;
  nativeCwd?: string;
  withLighthouse: boolean;
  artifact?: string;
  lighthouseEvidence?: string;
  out?: string;
  timeoutMs: number;
}

interface LocatorLike {
  waitFor(options: { state: 'visible'; timeout: number }): Promise<void>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  press(value: string): Promise<void>;
  check(): Promise<void>;
  selectOption(value: string): Promise<void>;
  isVisible(): Promise<boolean>;
  textContent(): Promise<string | null>;
}

export interface PageLike {
  on(event: string, listener: (value: unknown) => void): void;
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  waitForLoadState(state: 'load', options: { timeout: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): { first(): LocatorLike };
  url(): string;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<Buffer>;
}

interface ContextLike {
  tracing: {
    start(options: { screenshots: boolean; snapshots: boolean; sources: boolean }): Promise<void>;
    stop(options: { path: string }): Promise<void>;
  };
  addInitScript(script: string): Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface BrowserLike {
  newContext(options: { viewport: { width: number; height: number } }): Promise<ContextLike>;
  close(): Promise<void>;
}

export interface PlaywrightLike {
  chromium: {
    launch(options: { headless: boolean }): Promise<BrowserLike>;
  };
}

export interface OwnedServer {
  server: Server;
  mode: 'runtime-static' | 'runtime-command';
  url: string;
  port: number;
  startedAt: string;
  servedAssetHashes: Set<string>;
  child?: ChildProcess;
}

export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MAX_PROXY_BODY_BYTES = 32 * 1024 * 1024;
