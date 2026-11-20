#!/usr/bin/env node
/**
 * 把插件包镜像到 Gitee Release（GitHub 为主流水线，Gitee 为国内镜像）。
 * 前置：Gitee 仓库必须已存在同名 tag（CI 会先推送 main 与 tag）。
 *
 * 用法：
 *   GITEE_TOKEN=xxx node scripts/publish-gitee.mjs --tag v0.1.0
 *
 * 环境变量：
 *   GITEE_TOKEN    必填，私人令牌（projects 权限）
 *   GITEE_OWNER    默认 yukai1998
 *   GITEE_REPO     默认 AtoZPlugins
 *   GITEE_API_BASE 默认 https://gitee.com/api/v5
 *   GITEE_BRANCH   创建 Release 时关联的分支，默认 main
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const API = process.env.GITEE_API_BASE || 'https://gitee.com/api/v5'
const owner = process.env.GITEE_OWNER || 'yukai1998'
const repo = process.env.GITEE_REPO || 'AtoZPlugins'
const token = process.env.GITEE_TOKEN || ''

function argValue(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return ''
  const v = process.argv[i + 1]
  return !v || v.startsWith('--') ? '' : v
}
const tag = argValue('--tag')
const dir = path.resolve(root, argValue('--dir') || 'dist')
const dryRun = process.argv.includes('--dry-run')

const log = (m) => console.log(`[gitee] ${m}`)
function fail(m) {
  console.error(`✖ ${m}`)
  process.exit(1)
}

async function findRelease() {
  const res = await fetch(
    `${API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}?access_token=${encodeURIComponent(token)}`
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`查询 Release 失败：HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

async function createRelease() {
  const notesFile = path.join(dir, 'release-notes.md')
  const body = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf-8') : `插件中心 ${tag}`
  const res = await fetch(`${API}/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: token,
      tag_name: tag,
      name: `插件中心 ${tag}`,
      body,
      target_commitish: process.env.GITEE_BRANCH || 'main',
      prerelease: false
    })
  })
  if (res.ok) return res.json()
  const text = await res.text()
  const existing = await findRelease()
  if (existing) return existing
  throw new Error(`创建 Gitee Release 失败：HTTP ${res.status} ${text}`)
}

async function uploadAsset(releaseId, filePath) {
  const name = path.basename(filePath)
  const buffer = fs.readFileSync(filePath)
  const form = new FormData()
  form.append('access_token', token)
  form.append('file', new Blob([buffer]), name)
  const res = await fetch(`${API}/repos/${owner}/${repo}/releases/${releaseId}/attach_files`, {
    method: 'POST',
    body: form
  })
  if (res.ok) {
    log(`已上传 ${name}（${(buffer.length / 1024).toFixed(1)}KB）`)
    return
  }
  const text = await res.text()
  if (res.status === 400 && /已存在|exist/i.test(text)) {
    log(`已存在，跳过 ${name}`)
    return
  }
  throw new Error(`上传 ${name} 失败：HTTP ${res.status} ${text}`)
}

async function main() {
  if (!tag) fail('缺少 --tag（如 v0.1.0）')
  if (!fs.existsSync(dir)) fail(`目录不存在：${dir}`)
  const zips = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.zip'))
    .sort()
    .map((n) => path.join(dir, n))
  if (!zips.length) fail(`${dir} 下没有 .zip，先运行 npm run pack`)

  if (dryRun) {
    log(`将创建/复用 Release ${tag}，上传 ${zips.length} 个附件：`)
    for (const z of zips) log(`  - ${path.basename(z)}（${(fs.statSync(z).size / 1024).toFixed(1)}KB）`)
    return
  }
  if (!token) fail('缺少 GITEE_TOKEN（Gitee 私人令牌，勾选 projects 权限）')

  const release = (await findRelease()) || (await createRelease())
  const existing = new Set((release.assets ?? []).map((a) => a.name || a.attach_file_name))
  for (const file of zips) {
    if (existing.has(path.basename(file))) {
      log(`已存在，跳过 ${path.basename(file)}`)
      continue
    }
    await uploadAsset(release.id, file)
  }
  log(`完成：https://gitee.com/${owner}/${repo}/releases/tag/${tag}`)
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
