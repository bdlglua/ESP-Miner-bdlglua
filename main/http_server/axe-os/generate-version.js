const fs = require('fs');
const path = require('path');

// Source ZIPs have no .git directory. Match the patched firmware version
// when building from this archive without an explicit version override.
let version = process.env.AXEOS_WEB_VERSION;
if (!version) {
  try {
    version = require('child_process').execSync('git describe --tags --always --dirty', {
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim();
  } catch {
    // No git metadata: use the firmware version from the project CMakeLists.txt.
    const cmake = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'CMakeLists.txt'), 'utf8');
    const match = cmake.match(/set\(PROJECT_VER\s+"([^"]+)"\)/);
    version = match ? match[1] : 'unknown';
  }
}

const outputPath = path.join(__dirname, 'dist', 'axe-os', 'version.txt');
fs.writeFileSync(outputPath, version);

console.log(`Generated ${outputPath} with version ${version}`);
