// Render the CloXde logo into Android launcher icons at every density.
// Reuses the renderLogo() + encodePng() implementation from build-icon.cjs
// so the brandmark stays in sync (dark rounded square + two overlapping
// circles, blue + green).
//
// Writes ic_launcher.png AND ic_launcher_round.png at:
//   mdpi 48, hdpi 72, xhdpi 96, xxhdpi 144, xxxhdpi 192
//
// Run:  node scripts/build-android-icons.cjs

const fs = require('node:fs')
const path = require('node:path')

// Pull the renderer + PNG encoder out of the existing icon builder. They
// don't have a clean export, so we eval the shared bits into our own scope.
const buildIconSrc = fs.readFileSync(
  path.join(__dirname, 'build-icon.cjs'),
  'utf8'
)
// Strip the trailing "write the .ico" side effects — we only want the
// helpers. The cut-line is the `// main` section marker near the bottom.
const cutAt = buildIconSrc.indexOf('// main')
if (cutAt < 0) {
  throw new Error('Could not locate the // main marker in build-icon.cjs')
}
// eslint-disable-next-line no-eval
eval(buildIconSrc.slice(0, cutAt))

if (typeof renderLogo !== 'function' || typeof encodePng !== 'function') {
  throw new Error('renderLogo / encodePng not in scope — has build-icon.cjs been refactored?')
}

const densities = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192]
]

const ANDROID_RES = path.join(
  __dirname,
  '..',
  'mobile',
  'android',
  'app',
  'src',
  'main',
  'res'
)

for (const [d, size] of densities) {
  const rgba = renderLogo(size)
  const png = encodePng(size, size, rgba)
  const dir = path.join(ANDROID_RES, `mipmap-${d}`)
  fs.mkdirSync(dir, { recursive: true })
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
    fs.writeFileSync(path.join(dir, name), png)
  }
  console.log(`wrote ${d}/${size}px (ic_launcher + ic_launcher_round)`)
}

console.log('Done. Rebuild the APK with `cd mobile/android && ./gradlew app:installDebug` to see the new icon.')
