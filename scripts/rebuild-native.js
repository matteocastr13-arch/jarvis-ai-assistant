const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

// Native C++ modules currently target macOS (Objective-C++ / Carbon / CoreAudio)
if (process.platform !== 'darwin') {
  console.log(`[rebuild-native] Skipping native macOS addon rebuild on ${process.platform}.`);
  process.exit(0);
}

const electronVersion = require('electron/package.json').version;
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
const result = spawnSync(process.execPath, [nodeGyp, 'rebuild'], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    npm_config_target: electronVersion,
    npm_config_runtime: 'electron',
    npm_config_disturl: 'https://electronjs.org/headers',
    npm_config_arch: process.arch,
    npm_config_devdir: path.join(os.tmpdir(), 'jarvis-node-gyp')
  }
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
