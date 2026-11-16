const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..'),
  pkg = require('../package.json'),
  lock = require('../package-lock.json')
const runtime = path.join(root, 'node_modules/electron/dist')
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw Error('Windows x64 build machine required')
const compiler =
  process.env.FATIO_ISCC || process.env.JASTUDIO_ISCC ||
  path.join(process.env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe')
if (!fs.existsSync(compiler) || !fs.existsSync(path.join(runtime, 'electron.exe')))
  throw Error('构建机需要 Electron 运行时和 Inno Setup 6')
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fatio-package-'))
const release = path.join(root, 'release')
async function build() {
try {
  await require('./brand.cjs').buildBrand()
  const product = path.join(stage, 'app'),
    appRoot = path.join(product, 'resources', 'app')
  fs.cpSync(runtime, product, { recursive: true })
  const exe = path.join(product, 'Fatio.exe')
  fs.renameSync(path.join(product, 'electron.exe'), exe)
  const { rcedit } = await import('rcedit')
  await rcedit(exe, {
    icon: path.join(root, 'ui/fatio.ico'),
    'file-version': pkg.version,
    'product-version': pkg.version,
    'version-string': {
      ProductName: pkg.productName,
      FileDescription: pkg.productName,
      CompanyName: '蒋啊讲',
      OriginalFilename: 'Fatio.exe',
      InternalName: 'Fatio',
      LegalCopyright: '蒋啊讲 · AGPL-3.0-or-later'
    }
  })
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'channels-host.ps1'),
      '-OutputDirectory',
      path.join(product, 'resources/channels-host')
    ],
    { stdio: 'inherit', windowsHide: true }
  )
  fs.mkdirSync(appRoot, { recursive: true })
  for (const item of ['src', 'ui', 'LICENSE', 'NOTICE', 'README.md', 'package-lock.json']) {
    fs.cpSync(path.join(root, item), path.join(appRoot, item), {
      recursive: true,
      filter: (p) => !['creatorhub.cjs', 'review-live.cjs', 'jastudio.ico'].includes(path.basename(p))
    })
  }
  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        productName: pkg.productName,
        main: pkg.main,
        version: pkg.version,
        license: pkg.license,
        dependencies: pkg.dependencies
      },
      null,
      2
    )
  )
  for (const [rel, info] of Object.entries(lock.packages)) {
    if (!rel.startsWith('node_modules/') || info.dev) continue
    const src = path.join(root, rel)
    if (!fs.existsSync(src)) {
      if (info.optional) continue
      throw Error('缺少运行依赖 ' + rel)
    }
    fs.cpSync(src, path.join(appRoot, rel), {
      recursive: true,
      filter: (p) => path.basename(p) !== 'node_modules'
    })
  }
  fs.mkdirSync(release, { recursive: true })
  execFileSync(
    compiler,
    [
      '/Qp',
      '/DProductDir=' + product,
      '/DReleaseDir=' + release,
      '/DStudioVersion=' + pkg.version,
      '/DWebViewBootstrap=' +
        path.join(root, '.runtime/webview2-sdk/MicrosoftEdgeWebview2Setup.exe'),
      path.join(__dirname, 'windows.iss')
    ],
    { stdio: 'inherit', windowsHide: true }
  )
} finally {
  if (path.dirname(path.resolve(stage)) !== path.resolve(os.tmpdir()) || !path.basename(stage).startsWith('fatio-package-'))
    throw Error('Refusing to remove unexpected build directory')
  fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3 })
}
}
build().catch(error => { console.error(error); process.exitCode = 1 })
