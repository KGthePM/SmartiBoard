/**
 * The two pure functions in update.js — everything else touches the network, the filesystem or
 * a dialog, which is Kyle's to click through by hand. `node --test` is Node's own runner: zero
 * new dependencies, matching update.js itself.
 *
 * Run: node --test update.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isNewer, assetPattern } = require('./update');

test('isNewer', () => {
  assert.equal(isNewer('v6.1.0', '6.0.4'), true);
  assert.equal(isNewer('v6.0.4', '6.0.4'), false);
  assert.equal(isNewer('v6.0.3', '6.0.4'), false);
  assert.equal(isNewer('v7.0.0', '6.9.9'), true);
  assert.equal(isNewer('v6.0.10', '6.0.9'), true);
  assert.equal(isNewer('6.0.4', '6.0.4'), false); // tolerate a tag with no leading v
});

test('assetPattern picks the right asset per platform/arch', () => {
  const cases = [
    { platform: 'win32', arch: 'x64', appimage: undefined, name: 'SmartiBoard-6.1.0-win-x64-setup.exe' },
    { platform: 'darwin', arch: 'arm64', appimage: undefined, name: 'SmartiBoard-6.1.0-mac-arm64.dmg' },
    { platform: 'darwin', arch: 'x64', appimage: undefined, name: 'SmartiBoard-6.1.0-mac-x64.dmg' },
    { platform: 'linux', arch: 'x64', appimage: '/some/mount/App.AppImage', name: 'SmartiBoard-6.1.0-linux-x86_64.AppImage' },
    { platform: 'linux', arch: 'x64', appimage: undefined, name: 'SmartiBoard-6.1.0-linux-x64.deb' },
  ];

  for (const c of cases) {
    const origPlatform = process.platform;
    const origArch = process.arch;
    const origAppimage = process.env.APPIMAGE;
    Object.defineProperty(process, 'platform', { value: c.platform });
    Object.defineProperty(process, 'arch', { value: c.arch });
    if (c.appimage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = c.appimage;

    try {
      const pattern = assetPattern();
      assert.ok(pattern, `expected a pattern for ${c.platform}/${c.arch}`);
      assert.ok(pattern.test(c.name), `${pattern} should match ${c.name}`);
      // and it should not cross-match a sibling platform's asset
      const others = cases.filter((o) => o !== c).map((o) => o.name);
      for (const other of others) {
        assert.ok(!pattern.test(other), `${pattern} should not match ${other}`);
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      Object.defineProperty(process, 'arch', { value: origArch });
      if (origAppimage === undefined) delete process.env.APPIMAGE;
      else process.env.APPIMAGE = origAppimage;
    }
  }
});
