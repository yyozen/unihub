import { app, net } from 'electron'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync
} from 'fs'
import AdmZip from 'adm-zip'
import { pluginDevServer } from './plugin-dev-server'
import { permissionManager } from './permission-manager'
import { webContentsViewManager } from './webcontents-view-manager'
import { createLogger } from '../shared/logger'

const logger = createLogger('plugin-manager')

// 插件市场 CDN 备用地址
const MARKETPLACE_CDN_URL = 'https://cdn.jsdelivr.net/gh/t8y2/unihub@main/marketplace/plugins.json'

interface PackageJson {
  name: string
  version: string
  description?: string
  author?: string | { name: string; email?: string }
  license?: string
  keywords?: string[]
  homepage?: string
  repository?: string | { type: string; url: string }
  unihub?: {
    id: string
    name?: string
    version?: string
    description?: string
    author?: string | { name: string; email?: string }
    icon?: string
    category?: string
    entry?: string // 改为可选，默认使用 dist/index.html
    keywords?: string[]
    permissions?: string[]
    screenshots?: string[]
    homepage?: string
    repository?: string
    license?: string
    dev?: {
      enabled?: boolean
      url?: string
      autoReload?: boolean
    }
  }
}

interface PluginMetadata {
  id: string
  name: string
  version: string
  description: string
  author: string | { name: string; email?: string }
  entry: string
  icon?: string
  category: string
  keywords?: string[]
  permissions?: string[]
  isThirdParty?: boolean // 标记是否为第三方插件
  homepage?: string
  repository?: string
  license?: string
  dev?: {
    enabled?: boolean
    url?: string
    autoReload?: boolean
  }
}

interface InstalledPlugin {
  id: string
  version: string
  enabled: boolean
  installedAt: string
  source: string
  sourceUrl?: string
  metadata: PluginMetadata
}

export class PluginManager {
  private pluginsDir: string
  private pluginsDataFile: string
  private cachedPlugins: InstalledPlugin[] | null = null

  constructor() {
    const userDataPath = app.getPath('userData')
    this.pluginsDir = join(userDataPath, 'plugins')
    this.pluginsDataFile = join(userDataPath, 'plugins-data.json')

    if (!existsSync(this.pluginsDir)) {
      mkdirSync(this.pluginsDir, { recursive: true })
    }
  }

  async installPlugin(
    url: string
  ): Promise<{ success: boolean; message: string; pluginId?: string }> {
    try {
      logger.info({ url }, '开始安装插件')

      const buffer = await this.downloadWithRetry(url, 3)
      return await this.installFromBuffer(buffer, url)
    } catch (error) {
      logger.error({ err: error }, '安装插件失败')
      return { success: false, message: (error as Error).message }
    }
  }

  /**
   * 带重试机制的下载函数（使用 Electron net 模块，无超时限制）
   */
  private async downloadWithRetry(url: string, maxRetries: number = 3): Promise<Buffer> {
    let lastError: Error | null = null

    // 添加时间戳参数防止缓存
    const urlWithTimestamp = url.includes('?')
      ? `${url}&_t=${Date.now()}`
      : `${url}?_t=${Date.now()}`

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug({ attempt, maxRetries, url: urlWithTimestamp }, '下载尝试')

        // 使用 Electron 的 net.fetch，它没有内置的超时限制
        const response = await net.fetch(urlWithTimestamp, {
          headers: {
            'User-Agent': 'UniHub/1.0',
            Accept: 'application/zip,application/octet-stream,*/*',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache'
          }
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const buffer = Buffer.from(await response.arrayBuffer())
        logger.info({ size: `${(buffer.length / 1024).toFixed(2)} KB` }, '下载成功')
        return buffer
      } catch (error) {
        lastError = error as Error
        logger.warn({ attempt, maxRetries, error: lastError.message }, '下载失败')

        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxRetries) {
          const delay = 2000 * attempt // 递增延迟：2s, 4s, 6s
          logger.debug({ delay }, '等待后重试')
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    // 所有重试都失败了
    const errorMessage = lastError?.message || '未知错误'
    if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
      throw new Error(
        `下载超时，已重试 ${maxRetries} 次。请检查网络连接或稍后重试。\n提示：如果在中国大陆，可能需要配置代理访问 cdn.jsdelivr.net`
      )
    } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED')) {
      throw new Error(`无法连接到服务器，已重试 ${maxRetries} 次。请检查网络连接或 DNS 设置。`)
    } else {
      throw new Error(`下载失败: ${errorMessage}（已重试 ${maxRetries} 次）`)
    }
  }

  async installFromBuffer(
    buffer: Buffer | number[],
    filename: string
  ): Promise<{ success: boolean; message: string; pluginId?: string }> {
    try {
      logger.info({ filename }, '开始安装插件')

      // 如果是数组，转换为 Buffer
      const zipBuffer = Array.isArray(buffer) ? Buffer.from(buffer) : buffer

      const tempZip = join(app.getPath('temp'), 'plugin-temp.zip')
      const tempExtract = join(app.getPath('temp'), 'plugin-extract')

      writeFileSync(tempZip, zipBuffer)

      if (existsSync(tempExtract)) {
        rmSync(tempExtract, { recursive: true, force: true })
      }
      mkdirSync(tempExtract, { recursive: true })

      const zip = new AdmZip(tempZip)
      zip.extractAllTo(tempExtract, true)

      // 优先读取 package.json，兼容旧的 manifest.json
      let manifest: PluginMetadata
      const packageJsonPath = join(tempExtract, 'package.json')
      const manifestPath = join(tempExtract, 'manifest.json')

      if (existsSync(packageJsonPath)) {
        // 新格式：使用 package.json
        const pkg: PackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))

        if (!pkg.unihub) {
          throw new Error('package.json 中缺少 unihub 配置')
        }

        // 自动继承 package.json 字段到 unihub 配置
        manifest = this.mergePackageJsonWithUnihub(pkg, tempExtract)
      } else if (existsSync(manifestPath)) {
        // 旧格式：兼容 manifest.json
        const oldManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
        manifest = {
          ...oldManifest,
          entry: oldManifest.main || oldManifest.frontend?.entry || 'frontend/index.html'
        }
      } else {
        throw new Error('插件包中缺少 package.json 或 manifest.json')
      }

      const installed = this.getInstalledPlugins()
      if (installed.some((p) => p.id === manifest.id)) {
        throw new Error('插件已安装，请先卸载旧版本')
      }

      const pluginDir = join(this.pluginsDir, manifest.id)
      if (existsSync(pluginDir)) {
        rmSync(pluginDir, { recursive: true, force: true })
      }

      const fs = await import('fs/promises')
      await fs.cp(tempExtract, pluginDir, { recursive: true })

      // 给 sidecar 可执行文件添加执行权限
      const sidecarDir = join(pluginDir, 'sidecar')
      if (existsSync(sidecarDir)) {
        const { chmod } = await import('fs/promises')
        const { readdir } = await import('fs/promises')

        try {
          const files = await readdir(sidecarDir)
          for (const file of files) {
            const filePath = join(sidecarDir, file)
            // 给所有可执行文件添加执行权限
            if (file.endsWith('.exe') || !file.includes('.')) {
              await chmod(filePath, 0o755)
              logger.debug({ file }, '已添加执行权限')
            }
          }
        } catch (error) {
          logger.warn({ error }, '添加执行权限失败')
        }
      }

      const pluginInfo: InstalledPlugin = {
        id: manifest.id,
        version: manifest.version,
        enabled: true,
        installedAt: new Date().toISOString(),
        source: filename.startsWith('http') ? 'url' : 'local',
        sourceUrl: filename.startsWith('http') ? filename : undefined,
        metadata: manifest
      }

      this.savePluginInfo(pluginInfo)

      // 注册插件权限
      permissionManager.registerPlugin(manifest.id, manifest.permissions || [])

      logger.info({ name: manifest.name, id: manifest.id }, '插件安装成功')
      return { success: true, message: `插件 ${manifest.name} 安装成功`, pluginId: manifest.id }
    } catch (error) {
      logger.error({ error }, '安装插件失败')
      return { success: false, message: (error as Error).message }
    }
  }

  async uninstallPlugin(pluginId: string): Promise<{ success: boolean; message: string }> {
    try {
      // 关闭插件视图（如果打开的话）
      webContentsViewManager.removePluginView(pluginId)

      // 从已安装列表中移除
      const installed = this.getInstalledPlugins()
      const filtered = installed.filter((p) => p.id !== pluginId)
      writeFileSync(this.pluginsDataFile, JSON.stringify(filtered, null, 2))

      // 清除缓存
      this.cachedPlugins = null

      // 删除插件目录
      const pluginDir = join(this.pluginsDir, pluginId)
      if (existsSync(pluginDir)) {
        rmSync(pluginDir, { recursive: true, force: true })
      }

      // 移除插件权限
      permissionManager.unregisterPlugin(pluginId)

      logger.info({ pluginId }, '插件已卸载')

      return {
        success: true,
        message: '插件已卸载'
      }
    } catch (error) {
      logger.error({ err: error, pluginId }, '卸载插件失败')
      return { success: false, message: (error as Error).message }
    }
  }

  async listPlugins(): Promise<InstalledPlugin[]> {
    return this.getInstalledPlugins()
  }

  /**
   * 初始化已安装插件的权限
   */
  initializePermissions(): void {
    const installed = this.getInstalledPlugins()
    installed.forEach((plugin) => {
      if (plugin.enabled && plugin.metadata.permissions) {
        permissionManager.registerPlugin(plugin.id, plugin.metadata.permissions)
        logger.info(
          { pluginName: plugin.metadata.name, permissions: plugin.metadata.permissions },
          '已加载插件权限'
        )
      }
    })
  }

  async loadPlugin(pluginId: string): Promise<{
    success: boolean
    htmlPath?: string
    devUrl?: string
    entry?: string
    message?: string
  }> {
    try {
      // 检查是否为开发模式
      if (pluginDevServer.isDevMode(pluginId)) {
        const devUrl = pluginDevServer.getDevUrl(pluginId)
        if (devUrl) {
          return { success: true, devUrl }
        }
      }

      const installed = this.getInstalledPlugins()
      const plugin = installed.find((p) => p.id === pluginId)

      if (!plugin) {
        throw new Error('插件未安装')
      }

      // 检查插件配置中的开发模式
      if (plugin.metadata.dev?.enabled && plugin.metadata.dev?.url) {
        pluginDevServer.registerDevPlugin(
          pluginId,
          plugin.metadata.dev.url,
          plugin.metadata.dev.autoReload !== false
        )
        return { success: true, devUrl: plugin.metadata.dev.url }
      }

      const pluginDir = join(this.pluginsDir, pluginId)
      const htmlPath = join(pluginDir, plugin.metadata.entry)

      if (!existsSync(htmlPath)) {
        throw new Error('插件入口文件不存在')
      }

      return { success: true, htmlPath, entry: plugin.metadata.entry }
    } catch (error) {
      return { success: false, message: (error as Error).message }
    }
  }

  /**
   * 解析图标路径
   * 如果是相对路径（如 favicon.ico 或 dist/icon.png），转换为 plugin:// 协议的 URL
   */
  private resolveIconPath(icon: string | undefined, pluginId: string): string | undefined {
    if (!icon) return undefined

    // 如果是 emoji、SVG path、或已经是完整 URL，直接返回
    if (
      icon.startsWith('http') ||
      icon.startsWith('data:') ||
      icon.startsWith('M') ||
      icon.startsWith('m') ||
      icon.length <= 4 // emoji 通常很短
    ) {
      return icon
    }

    // 相对路径，转换为 plugin:// URL
    // 去掉开头的 ./ 或 /
    const cleanPath = icon.replace(/^\.?\//, '')
    return `plugin://${pluginId}/${cleanPath}`
  }

  /**
   * 递归查找插件目录中的 index.html 文件
   * 优先级：dist/index.html > frontend/index.html > 根目录 index.html > 任意子目录的 index.html
   */
  private findIndexHtml(pluginDir: string): string | null {
    // 优先查找常见位置
    const commonPaths = ['dist/index.html', 'frontend/index.html', 'index.html']
    for (const path of commonPaths) {
      const fullPath = join(pluginDir, path)
      if (existsSync(fullPath)) {
        logger.info({ path }, '找到入口文件（常见位置）')
        return path
      }
    }

    // 递归查找所有 index.html（最大深度 3 层，避免性能问题）
    const findRecursive = (
      dir: string,
      relativePath: string = '',
      depth: number = 0
    ): string | null => {
      if (depth > 3) return null

      try {
        const entries = readdirSync(dir)

        for (const entry of entries) {
          // 跳过 node_modules 和隐藏目录
          if (entry === 'node_modules' || entry.startsWith('.')) continue

          const fullPath = join(dir, entry)
          const relPath = relativePath ? `${relativePath}/${entry}` : entry

          try {
            const stat = statSync(fullPath)

            if (stat.isFile() && entry === 'index.html') {
              logger.info({ path: relPath }, '找到入口文件（递归查找）')
              return relPath
            }

            if (stat.isDirectory()) {
              const found = findRecursive(fullPath, relPath, depth + 1)
              if (found) return found
            }
          } catch {
            // 忽略无法访问的文件/目录
            continue
          }
        }
      } catch {
        // 忽略无法读取的目录
      }

      return null
    }

    return findRecursive(pluginDir)
  }

  /**
   * 将 package.json 字段自动继承到 unihub 配置中
   * 只有当 unihub 字段未提供时才会继承
   */
  private mergePackageJsonWithUnihub(pkg: PackageJson, pluginDir: string): PluginMetadata {
    const unihub = pkg.unihub!

    // 处理 author 字段的继承
    const getAuthorInfo = (
      unihubAuthor?: string | { name: string; email?: string },
      pkgAuthor?: string | { name: string; email?: string }
    ): string | { name: string; email?: string } => {
      if (unihubAuthor) return unihubAuthor
      if (pkgAuthor) return pkgAuthor
      return 'Unknown'
    }

    // 处理 repository 字段的继承
    const getRepositoryUrl = (
      unihubRepo?: string,
      pkgRepo?: string | { type: string; url: string }
    ): string | undefined => {
      if (unihubRepo) return unihubRepo
      if (typeof pkgRepo === 'string') return pkgRepo
      if (pkgRepo && typeof pkgRepo === 'object' && pkgRepo.url) return pkgRepo.url
      return undefined
    }

    // 自动推断 entry（如果未提供）
    const getEntry = (unihubEntry?: string): string => {
      if (unihubEntry) return unihubEntry

      // 递归查找 index.html
      const foundEntry = this.findIndexHtml(pluginDir)
      if (foundEntry) return foundEntry

      // 如果找不到，使用默认值（会在 loadPlugin 时报错）
      logger.warn({ pluginId: unihub.id }, '未找到 index.html，使用默认值 dist/index.html')
      return 'dist/index.html'
    }

    return {
      // 必填字段
      id: unihub.id,
      entry: getEntry(unihub.entry),

      // 可继承字段
      name: unihub.name || pkg.name,
      version: unihub.version || pkg.version,
      description: unihub.description || pkg.description || '',
      author: getAuthorInfo(unihub.author, pkg.author),

      // 可选字段的继承
      icon: this.resolveIconPath(unihub.icon, unihub.id),
      category: unihub.category || 'tool',
      keywords: unihub.keywords || pkg.keywords || [],
      permissions: unihub.permissions || [],

      // 扩展字段的继承
      homepage: unihub.homepage || pkg.homepage,
      repository: getRepositoryUrl(unihub.repository, pkg.repository),
      license: unihub.license || pkg.license,

      // 开发配置
      dev: unihub.dev
    }
  }

  private getInstalledPlugins(): InstalledPlugin[] {
    // 使用缓存
    if (this.cachedPlugins !== null) {
      return this.cachedPlugins as InstalledPlugin[]
    }

    if (!existsSync(this.pluginsDataFile)) {
      this.cachedPlugins = []
      return this.cachedPlugins as InstalledPlugin[]
    }

    try {
      const data = readFileSync(this.pluginsDataFile, 'utf-8')
      this.cachedPlugins = JSON.parse(data) as InstalledPlugin[]
      return this.cachedPlugins as InstalledPlugin[]
    } catch {
      this.cachedPlugins = []
      return this.cachedPlugins as InstalledPlugin[]
    }
  }

  /**
   * 预热缓存 - 在应用启动时调用
   */
  warmupCache(): void {
    this.getInstalledPlugins()
  }

  /**
   * 检查插件更新
   * @param marketplaceUrl 插件市场 URL
   * @returns 有更新的插件列表
   */
  async checkPluginUpdates(marketplaceUrl: string): Promise<{
    success: boolean
    updates: Array<{
      id: string
      name: string
      currentVersion: string
      latestVersion: string
      changelog?: string
      downloadUrl?: string
    }>
    message?: string
  }> {
    try {
      logger.info({ marketplaceUrl }, '开始检查插件更新')

      // 获取已安装的插件
      const installed = this.getInstalledPlugins()
      if (installed.length === 0) {
        logger.info('没有已安装的插件，跳过更新检查')
        return { success: true, updates: [] }
      }

      // 获取市场插件列表，失败时自动降级到 CDN
      logger.debug('正在获取插件市场数据...')
      let response = await net.fetch(marketplaceUrl)

      // 如果主 API 失败，尝试 CDN 备用地址
      if (!response.ok) {
        logger.warn(
          { status: response.status, fallbackUrl: MARKETPLACE_CDN_URL },
          'API 请求失败，尝试 CDN 备用地址'
        )
        response = await net.fetch(MARKETPLACE_CDN_URL)
      }

      if (!response.ok) {
        const errorMsg = `HTTP ${response.status}: ${response.statusText}`
        logger.error(
          { status: response.status, statusText: response.statusText },
          '获取插件市场数据失败'
        )
        throw new Error(errorMsg)
      }

      const marketData = (await response.json()) as {
        plugins: Array<{
          id: string
          name: string
          version: string
          install: { zip?: string }
        }>
      }

      if (!marketData.plugins || !Array.isArray(marketData.plugins)) {
        throw new Error('插件市场数据格式错误')
      }

      logger.debug({ pluginCount: marketData.plugins.length }, '成功获取插件市场数据')

      // 比较版本，找出有更新的插件
      const updates: Array<{
        id: string
        name: string
        currentVersion: string
        latestVersion: string
        changelog?: string
        downloadUrl?: string
      }> = []

      for (const installedPlugin of installed) {
        const marketPlugin = marketData.plugins.find((p) => p.id === installedPlugin.id)
        if (!marketPlugin) {
          logger.debug({ pluginId: installedPlugin.id }, '插件不在市场中，跳过')
          continue
        }

        const currentVersion = installedPlugin.version
        const latestVersion = marketPlugin.version

        // 比较版本号
        if (this.compareVersions(latestVersion, currentVersion) > 0) {
          logger.info(
            {
              pluginId: installedPlugin.id,
              currentVersion,
              latestVersion
            },
            '发现插件更新'
          )
          updates.push({
            id: installedPlugin.id,
            name: installedPlugin.metadata.name,
            currentVersion,
            latestVersion,
            downloadUrl: marketPlugin.install.zip
          })
        }
      }

      logger.info({ count: updates.length }, '检查更新完成')
      return { success: true, updates }
    } catch (error) {
      const errorMessage = (error as Error).message
      logger.error({ error: errorMessage, marketplaceUrl }, '检查插件更新失败')
      return {
        success: false,
        updates: [],
        message: errorMessage
      }
    }
  }

  /**
   * 更新插件
   * @param pluginId 插件 ID
   * @param downloadUrl 下载地址
   */
  async updatePlugin(
    pluginId: string,
    downloadUrl: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      logger.info({ pluginId, downloadUrl }, '开始更新插件')

      // 先卸载旧版本
      const uninstallResult = await this.uninstallPlugin(pluginId)
      if (!uninstallResult.success) {
        throw new Error(`卸载旧版本失败: ${uninstallResult.message}`)
      }

      // 安装新版本
      const installResult = await this.installPlugin(downloadUrl)
      if (!installResult.success) {
        throw new Error(`安装新版本失败: ${installResult.message}`)
      }

      logger.info({ pluginId }, '插件更新成功')
      return { success: true, message: '插件更新成功' }
    } catch (error) {
      logger.error({ error, pluginId }, '更新插件失败')
      return { success: false, message: (error as Error).message }
    }
  }

  /**
   * 比较版本号
   * @returns 1: v1 > v2, 0: v1 = v2, -1: v1 < v2
   */
  private compareVersions(version1: string, version2: string): number {
    const v1Parts = version1.split('.').map(Number)
    const v2Parts = version2.split('.').map(Number)
    const maxLength = Math.max(v1Parts.length, v2Parts.length)

    for (let i = 0; i < maxLength; i++) {
      const v1Part = v1Parts[i] || 0
      const v2Part = v2Parts[i] || 0

      if (v1Part > v2Part) return 1
      if (v1Part < v2Part) return -1
    }

    return 0
  }

  private savePluginInfo(plugin: InstalledPlugin): void {
    // 先清除缓存，确保读取最新数据
    this.cachedPlugins = null

    const installed = this.getInstalledPlugins()

    // 检查是否已存在（防止重复）
    const existingIndex = installed.findIndex((p) => p.id === plugin.id)
    if (existingIndex >= 0) {
      // 更新现有插件
      installed[existingIndex] = plugin
      logger.info({ pluginName: plugin.metadata.name }, '更新插件信息')
    } else {
      // 添加新插件
      installed.push(plugin)
      logger.info({ pluginName: plugin.metadata.name }, '添加新插件')
    }

    writeFileSync(this.pluginsDataFile, JSON.stringify(installed, null, 2))

    // 清除缓存
    this.cachedPlugins = null
  }
}
