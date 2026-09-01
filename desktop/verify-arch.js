/**
 * electron-builder afterPack hook.
 *
 * stage.js fetches a better-sqlite3 binary for one specific platform and architecture. If
 * electron-builder is then pointed at a different one — `npm run stage` on an arm64 Mac followed
 * by `electron-builder --mac --x64`, say — the app packages happily, opens its window, and dies
 * on the first database call with an unhelpful error. That failure is far away from its cause,
 * so refuse it here instead.
 */

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// electron-builder's Arch enum, by index.
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

exports.default = async function verifyArch(context) {
  const staged = JSON.parse(readFileSync(join(__dirname, 'app', '.staged.json'), 'utf8'));
  const wantPlatform = context.electronPlatformName;
  const wantArch = ARCH_NAMES[context.arch];

  if (staged.platform !== wantPlatform || staged.arch !== wantArch) {
    throw new Error(
      `Staged for ${staged.platform}-${staged.arch} but packaging ${wantPlatform}-${wantArch}.\n` +
        `The native better-sqlite3 binary would be the wrong one. Re-run:\n` +
        `  node stage.js --platform=${wantPlatform} --arch=${wantArch}`,
    );
  }
};
