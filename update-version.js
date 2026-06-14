const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

try {
  // 1. Get the current commit count
  const countStr = execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim();
  const commitCount = parseInt(countStr, 10);
  if (isNaN(commitCount)) {
    throw new Error('Could not parse commit count: ' + countStr);
  }
  
  // Since the commit is about to be created, the count of that commit will be commitCount + 1
  const nextVersion = `1.1.${commitCount + 1}`;
  const cacheName = `yumi-v${commitCount + 1}`;

  console.log(`[Version Bump] Next version: ${nextVersion}`);
  console.log(`[Version Bump] Cache name: ${cacheName}`);

  // 2. Update manifest.json
  const manifestPath = path.join(__dirname, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = nextVersion;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`[Version Bump] Updated manifest.json to version ${nextVersion}`);
  }

  // 3. Update app.js
  const appPath = path.join(__dirname, 'app.js');
  if (fs.existsSync(appPath)) {
    let appContent = fs.readFileSync(appPath, 'utf8');
    appContent = appContent.replace(/version:\s*'[^']+'/, `version: '${nextVersion}'`);
    fs.writeFileSync(appPath, appContent, 'utf8');
    console.log(`[Version Bump] Updated app.js to version ${nextVersion}`);
  }

  // 4. Update sw.js
  const swPath = path.join(__dirname, 'sw.js');
  if (fs.existsSync(swPath)) {
    let swContent = fs.readFileSync(swPath, 'utf8');
    swContent = swContent.replace(/const\s+CACHE_NAME\s*=\s*'[^']+'/, `const CACHE_NAME = '${cacheName}'`);
    fs.writeFileSync(swPath, swContent, 'utf8');
    console.log(`[Version Bump] Updated sw.js to CACHE_NAME ${cacheName}`);
  }

  // 5. Stage the updated files
  execSync('git add manifest.json app.js sw.js');
  console.log('[Version Bump] Staged updated files.');

} catch (err) {
  console.error('[Version Bump] Error updating versions:', err);
  process.exit(1);
}
