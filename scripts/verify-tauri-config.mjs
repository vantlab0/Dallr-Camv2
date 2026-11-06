#!/usr/bin/env node
/**
 * Static verification of the Tauri desktop configuration.
 *
 * This catches the two most common desktop regressions:
 *  1. A multi-window / video-output feature that is missing native permissions.
 *  2. A CSP that blocks the video pipeline (mediastream/blob) or the backend APIs.
 *
 * It is intentionally dependency-free so it can run on a clean CI runner.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`✗ ${message}`)
  process.exitCode = 1
}

function ok(message) {
  console.log(`✓ ${message}`)
}

function readJson(relPath) {
  const full = resolve(root, relPath)
  if (!existsSync(full)) {
    fail(`Missing required file: ${relPath}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(full, 'utf8'))
  } catch (err) {
    fail(`Invalid JSON in ${relPath}: ${err.message}`)
    return null
  }
}

const tauriConfig = readJson('src-tauri/tauri.conf.json')
const capabilities = readJson('src-tauri/capabilities/default.json')

if (tauriConfig) {
  const windows = tauriConfig.app?.windows || []
  if (!windows.some((w) => w.label === 'main' || w.title === 'Dallr Cam')) {
    fail('tauri.conf.json must define the main application window')
  } else {
    ok('main window configured')
  }

  const csp = String(tauriConfig.app?.security?.csp || '')
  const cspRequirements = [
    ['media-src', 'mediastream:'],
    ['media-src', 'blob:'],
    ['img-src', 'blob:'],
    ['connect-src', 'https://*.supabase.co'],
    ['connect-src', 'wss://*.supabase.co'],
    ['connect-src', 'https://api.decart.ai'],
    ['connect-src', 'wss://*.decart.ai'],
    ['connect-src', 'https://api.paystack.co'],
  ]
  for (const [, token] of cspRequirements) {
    if (!csp.includes(token)) {
      fail(`CSP is missing required token "${token}" (needed for desktop video / backend connectivity)`)
    }
  }
  ok('CSP permits video pipeline and backend APIs')

  const icons = tauriConfig.bundle?.icon || []
  for (const icon of icons) {
    if (!existsSync(resolve(root, 'src-tauri', icon))) {
      fail(`Bundle icon is missing: ${icon}`)
    }
  }
  ok('bundle icons exist')
}

if (capabilities) {
  const permissions = new Set(capabilities.permissions || [])
  const required = [
    'core:default',
    'core:webview:allow-create-webview-window',
    'core:webview:allow-create-webview',
    'core:window:allow-create',
    'core:window:allow-destroy',
    'core:window:allow-close',
    'core:window:allow-show',
    'core:window:allow-set-focus',
  ]
  for (const permission of required) {
    if (!permissions.has(permission)) {
      fail(`Missing native permission: ${permission}`)
    }
  }
  ok('native multi-window / video-output permissions present')

  const windows = capabilities.windows || []
  for (const label of ['main', 'video-output']) {
    if (!windows.includes(label)) {
      fail(`Capabilities do not apply to window "${label}"`)
    }
  }
  ok('capabilities cover main and video-output windows')
}

if (process.exitCode) {
  console.error('\nTauri desktop configuration verification FAILED.')
} else {
  console.log('\nTauri desktop configuration verification passed.')
}
