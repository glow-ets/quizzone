#!/usr/bin/env node
// Type-checks the firmware against MakeCode's real declaration files.
//
//   node firmware/tools/typecheck.mjs
//
// It needs three public repositories (shallow clones, ~100 MB total) which are
// fetched into firmware/.cache on first use:
//   microsoft/pxt-microbit, microsoft/pxt-common-packages, microsoft/pxt (libs/pxt-common only)
// Set PXT_SRC=<dir> to reuse existing clones (dir containing pxt-microbit/, pxt-common-packages/, pxt_core/).
//
// This catches wrong API names/signatures, but it is NOT the MakeCode compiler:
// MakeCode's "static TypeScript" has extra restrictions that only the editor
// reports. Always import the project into https://makecode.microbit.org once.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fwDir = path.resolve(here, '..');
const srcDir = path.join(fwDir, 'src');
const cache = process.env.PXT_SRC ? path.resolve(process.env.PXT_SRC) : path.join(fwDir, '.cache');

function sh(cmd, args, cwd) { execFileSync(cmd, args, { cwd, stdio: 'inherit' }); }
function ensureClones() {
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(path.join(cache, 'pxt-microbit')))
    sh('git', ['clone', '--depth', '1', '-q', 'https://github.com/microsoft/pxt-microbit.git'], cache);
  if (!fs.existsSync(path.join(cache, 'pxt-common-packages')))
    sh('git', ['clone', '--depth', '1', '-q', 'https://github.com/microsoft/pxt-common-packages.git'], cache);
  if (!fs.existsSync(path.join(cache, 'pxt_core'))) {
    sh('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '-q', 'https://github.com/microsoft/pxt.git', 'pxt_core'], cache);
    sh('git', ['sparse-checkout', 'set', 'libs/pxt-common'], path.join(cache, 'pxt_core'));
  }
}

const readJson = (d) => JSON.parse(fs.readFileSync(path.join(d, 'pxt.json'), 'utf8'));
const tsLike = (f) => /\.ts$/.test(f);

function makecodeDeclarations() {
  const coreDir = path.join(cache, 'pxt-microbit/libs/core');
  const baseDir = path.join(cache, 'pxt-common-packages/libs/base');
  const radioDir = path.join(cache, 'pxt-common-packages/libs/radio');
  const coreFiles = (readJson(coreDir).files || []).filter(tsLike);
  const coreNames = new Set(coreFiles);
  // pxt rule: a file in "core" overrides a base file of the same name
  const baseFiles = (readJson(baseDir).files || []).filter(tsLike)
    .filter((f) => !coreNames.has(f) && !fs.existsSync(path.join(coreDir, f)));
  const radioFiles = (readJson(radioDir).files || []).filter(tsLike);
  return [
    path.join(cache, 'pxt_core/libs/pxt-common/pxt-core.d.ts'),
    path.join(cache, 'pxt_core/libs/pxt-common/pxt-helpers.ts'),
    ...baseFiles.map((f) => path.join(baseDir, f)),
    ...coreFiles.map((f) => path.join(coreDir, f)),
    ...radioFiles.map((f) => path.join(radioDir, f)),
  ].filter((f) => fs.existsSync(f));
}

// Project definitions: file order matters (main file last), exactly as in the MakeCode project.
export const PROJECTS = {
  team: ['qz_config.ts', 'qz_protocol.ts', 'qz_team.ts', 'team_main.ts'],
  base: ['qz_config.ts', 'qz_protocol.ts', 'qz_base.ts', 'base_main.ts'],
  probe: ['probe_main.ts'],
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureClones();
  const decl = makecodeDeclarations();
  const tmp = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : '.', 'qz-tc-'));
  let failed = false;
  for (const [name, files] of Object.entries(PROJECTS)) {
    const mine = files.map((f) => path.join(srcDir, f));
    const cfg = {
      compilerOptions: { noEmit: true, noLib: true, target: 'es2017', strict: false, skipLibCheck: true, types: [] },
      files: [...decl, ...mine],
    };
    const cfgPath = path.join(tmp, `tsconfig.${name}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    let out = '';
    try { execFileSync('tsc', ['-p', cfgPath], { encoding: 'utf8' }); }
    catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    // MakeCode's own library sources contain a few errors when checked outside the pxt toolchain
    // (e.g. hex`` literals); only errors located in OUR files count.
    const mineErrors = out.split('\n').filter((l) => {
      const m = /^(.*?)\(\d+,\d+\): error TS/.exec(l);
      return m && path.resolve(process.cwd(), m[1]).startsWith(srcDir + path.sep);
    });
    if (mineErrors.length) { failed = true; console.log(`FAIL ${name}`); mineErrors.forEach((l) => console.log('  ' + l)); }
    else console.log(`ok   ${name}  (${files.join(', ')})`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
