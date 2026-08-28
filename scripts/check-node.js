// Runs as `preinstall`, which means it runs on whatever Node the user happens to
// have — including ones far older than this project supports. Keep it ES5-plain:
// no optional chaining, no template literals, no dependencies, no imports.
//
// The floor is 22 rather than better-sqlite3's advertised 20 because its published
// prebuilt binaries cover ABI 127/137/141/147 only (Node 22/24/25/26). On Node 20
// the install "works" by falling back to node-gyp, which needs python3 and a C++
// toolchain and fails on plenty of machines. Refusing 20 is the honest floor.

var MIN = 22;
var MAX = 26;

var version = process.versions.node;
var major = parseInt(version.split('.')[0], 10);

if (major >= MIN && major <= MAX) {
  process.exit(0);
}

var lines = [
  '',
  '  Smarti Board needs Node ' + MIN + '-' + MAX + ' — you have v' + version + '.',
  '',
  '  Easiest fix, nothing to install:',
  '',
  '      ./start.sh          # fetches its own Node into .node/ and runs the app',
  '',
  '  Or install Node yourself:',
  '',
  '      nvm install 24 && nvm use 24',
  '',
  '  ...or, on Debian/Ubuntu without nvm:',
  '',
  '      curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -',
  '      sudo apt-get install -y nodejs',
  '',
  '  Then:  rm -rf node_modules && npm install',
  ''
];

console.error(lines.join('\n'));
process.exit(1);
