#!/usr/bin/env node
/**
 * AtoZ 插件中心打包器：扫描 plugins/ → 校验清单 → 打 zip → 算 sha256 → 生成 registry.json。
 *
 * 用法：
 *   node scripts/build-tools.mjs                       # 用 package.json 里的版本 tag？不需要，tag 由参数给
 *   node scripts/build-tools.mjs --tag v0.1.0
 *
 * 参数：
 *   --src <dir>          插件根目录，默认 plugins
 *   --out <dir>          输出目录，默认 dist
 *   --tag <tag>          发布标签（如 v0.1.0），用于拼 Release 下载地址
 *   --github-repo <o/r>  GitHub 仓库，默认 cocYu/my-dash-plugins
 *   --gitee-repo <o/r>   Gitee 仓库，默认 yukai1998/my-dash-plugins
 *   --primary <gitee|github>  首选下载源，默认 gitee（境内直连快）
 *   --base-url <url>     本地/自建服务器前缀（本地验证用）
 *   --only <ids>         只处理指定插件（逗号分隔）
 *   --check              只校验，不产出文件
 *   --registry <path>    索引输出路径，默认 <out>/registry.json（发布时传 registry.json）
 *
 * 产物：dist/<id>-<version>.zip、dist/release-notes.md、dist/registry.json（--registry 可改）
 * 可复现：zip 内时间戳固定，同样的源文件两次打包 sha256 一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.idea', '.vscode'])
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
const MAX_PLUGIN_BYTES = 10 * 1024 * 1024
/** 固定 zip 内时间戳，保证同源文件产出相同 sha256（1980-01-01 是 zip 纪元零点） */
const FIXED_DATE = new Date('1980-01-01T00:00:00Z')

function argValue(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return ''
  const v = process.argv[i + 1]
  return !v || v.startsWith('--') ? '' : v
}
const hasFlag = (name) => process.argv.includes(name)

const srcDir = path.resolve(root, argValue('--src') || 'plugins')
const outDir = path.resolve(root, argValue('--out') || 'dist')
const tag = argValue('--tag') || process.env.TOOLS_TAG || ''
const githubRepo = argValue('--github-repo') || process.env.TOOLS_GITHUB_REPO || 'cocYu/my-dash-plugins'
const giteeRepo = argValue('--gitee-repo') || process.env.TOOLS_GITEE_REPO || 'yukai1998/my-dash-plugins'
const baseUrl = argValue('--base-url').replace(/\/+$/, '')
const primary = (argValue('--primary') || 'gitee').toLowerCase()
const only = new Set(
  (argValue('--only') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)
const checkOnly = hasFlag('--check')
const outArg = argValue('--out') || 'dist'
const registryPath = path.resolve(root, argValue('--registry') || path.join(outArg, 'registry.json'))

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}
const log = (message) => console.log(`[plugins] ${message}`)

/** 递归收集插件文件，返回 posix 相对路径列表（排序保证打包稳定） */
function collectFiles(dir, base = dir, acc = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name)
    const st = fs.lstatSync(abs)
    if (st.isSymbolicLink()) throw new Error(`不允许符号链接：${path.relative(base, abs)}`)
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      collectFiles(abs, base, acc)
      continue
    }
    if (!st.isFile() || SKIP_FILES.has(name)) continue
    acc.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/'), size: st.size })
  }
  return acc
}

function readManifest(dir) {
  const file = path.join(dir, 'plugin.json')
  if (!fs.existsSync(file)) throw new Error('缺少 plugin.json')
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    throw new Error(`plugin.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
  const id = String(raw.id ?? '')
  if (!ID_PATTERN.test(id)) throw new Error(`id 非法（需 ${ID_PATTERN.source}）："${id}"`)
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('缺少 name')
  const version = String(raw.version ?? '')
  if (!VERSION_PATTERN.test(version)) throw new Error(`version 需形如 1.2.3："${version}"`)
  if (typeof raw.main !== 'string' || !raw.main.trim()) throw new Error('缺少 main')
  const entry = path.join(dir, raw.main)
  if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) throw new Error(`入口文件不存在：${raw.main}`)
  return {
    id,
    name: raw.name.trim(),
    version,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : '其他',
    main: raw.main,
    permissions: Array.isArray(raw.permissions) ? raw.permissions.map(String) : []
  }
}

function buildDownloadUrls(fileName) {
  const gh = githubRepo && tag ? `https://github.com/${githubRepo}/releases/download/${tag}/${fileName}` : ''
  const ge = giteeRepo && tag ? `https://gitee.com/${giteeRepo}/releases/download/${tag}/${fileName}` : ''
  if (baseUrl) return { url: `${baseUrl}/${fileName}`, mirrors: [gh, ge].filter(Boolean) }
  const order = primary === 'github' ? [gh, ge] : [ge, gh]
  const list = order.filter(Boolean)
  if (!list.length) fail('缺少下载地址：要么给 --tag（配合默认仓库），要么给 --base-url')
  return { url: list[0], mirrors: list.slice(1) }
}

function main() {
  if (!fs.existsSync(srcDir)) fail(`插件目录不存在：${srcDir}`)
  const dirs = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => !only.size || only.has(name))
    .sort()
  if (!dirs.length) fail(`没有找到插件（${srcDir}）`)

  if (!checkOnly) fs.mkdirSync(outDir, { recursive: true })

  const built = []
  const problems = []
  for (const name of dirs) {
    const dir = path.join(srcDir, name)
    try {
      const manifest = readManifest(dir)
      const files = collectFiles(dir)
      const total = files.reduce((n, f) => n + f.size, 0)
      if (total > MAX_PLUGIN_BYTES) throw new Error(`插件体积 ${(total / 1024 / 1024).toFixed(1)}MB 超过 10MB 上限`)
      if (!files.some((f) => f.rel === 'plugin.json')) throw new Error('plugin.json 未包含在打包列表')
      const fileName = `${manifest.id}-${manifest.version}.zip`
      if (checkOnly) {
        log(`✓ ${manifest.id} v${manifest.version}（${files.length} 个文件，${(total / 1024).toFixed(1)}KB）`)
        built.push({ manifest, fileName })
        continue
      }
      const zip = new AdmZip()
      for (const f of files) {
        zip.addFile(f.rel, fs.readFileSync(f.abs)).header.time = FIXED_DATE
      }
      const buf = zip.toBuffer()
      fs.writeFileSync(path.join(outDir, fileName), buf)
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
      const { url, mirrors } = buildDownloadUrls(fileName)
      built.push({ manifest, fileName, sha256, size: buf.length, url, mirrors })
      log(`✓ ${manifest.id} v${manifest.version} → ${fileName}（${(buf.length / 1024).toFixed(1)}KB，sha256 ${sha256.slice(0, 12)}…）`)
    } catch (err) {
      problems.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (problems.length) {
    for (const p of problems) console.error(`✖ ${p}`)
    fail(`${problems.length} 个插件校验失败，已中止`)
  }
  if (checkOnly) {
    log(`校验通过：${built.length} 个插件`)
    return
  }

  const registry = built
    .map((b) => ({
      id: b.manifest.id,
      name: b.manifest.name,
      version: b.manifest.version,
      description: b.manifest.description || undefined,
      category: b.manifest.category,
      downloadUrl: b.url,
      ...(b.mirrors.length ? { mirrors: b.mirrors } : {}),
      sha256: b.sha256,
      size: b.size
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  fs.mkdirSync(path.dirname(registryPath), { recursive: true })
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`)
  log(`索引已写入 ${path.relative(root, registryPath)}（${registry.length} 条）`)

  const lines = [
    `# 插件中心 ${tag || '(本地构建)'}`,
    '',
    '| 插件 | 版本 | 大小 | 说明 |',
    '| --- | --- | --- | --- |',
    ...registry.map(
      (r) => `| \`${r.id}\` · ${r.name} | ${r.version} | ${(r.size / 1024).toFixed(0)} KB | ${r.description || '—'} |`
    ),
    '',
    `共 ${registry.length} 个插件。安装：AtoZ → 工具箱 → 获取工具。`
  ]
  fs.writeFileSync(path.join(outDir, 'release-notes.md'), `${lines.join('\n')}\n`)
  log(`完成：${built.length} 个插件包 → ${path.relative(root, outDir)}/`)
}

main()
