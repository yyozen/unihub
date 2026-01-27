#!/usr/bin/env node

/**
 * 从远程插件仓库同步 plugins.json
 * 用法: node scripts/sync-plugins-from-remote.js
 */

import https from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PLUGINS_REPO_URL =
  'https://raw.githubusercontent.com/t8y2/unihub-plugins/main/marketplace/plugins.json'
const LOCAL_PLUGINS_PATH = path.join(__dirname, '../marketplace/plugins.json')

function fetchPluginsJson() {
  return new Promise((resolve, reject) => {
    https
      .get(PLUGINS_REPO_URL, (res) => {
        let data = ''

        res.on('data', (chunk) => {
          data += chunk
        })

        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data)
          } else {
            reject(new Error(`Failed to fetch: ${res.statusCode}`))
          }
        })
      })
      .on('error', reject)
  })
}

async function syncPlugins() {
  try {
    console.log('🔄 Fetching plugins.json from remote repository...')
    const remoteData = await fetchPluginsJson()

    // 验证 JSON 格式
    const pluginsData = JSON.parse(remoteData)
    console.log(`✅ Found ${pluginsData.plugins.length} plugins`)

    // 写入本地文件
    fs.writeFileSync(LOCAL_PLUGINS_PATH, JSON.stringify(pluginsData, null, 2), 'utf-8')
    console.log(`✅ Successfully synced to ${LOCAL_PLUGINS_PATH}`)

    // 显示更新信息
    console.log(`\n📦 Plugin List:`)
    pluginsData.plugins.forEach((plugin, index) => {
      console.log(`  ${index + 1}. ${plugin.name} (${plugin.version}) - ${plugin.author.name}`)
    })
  } catch (error) {
    console.error('❌ Sync failed:', error.message)
    console.error('\n💡 Possible reasons:')
    console.error('  1. Remote repository not yet created or pushed')
    console.error('  2. Network connection issue')
    console.error('  3. Invalid JSON format in remote file')
    console.error(`\n🔗 Remote URL: ${PLUGINS_REPO_URL}`)
    process.exit(1)
  }
}

syncPlugins()
