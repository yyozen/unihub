import { BrowserWindow, WebContentsView, ipcMain } from 'electron'
import { join } from 'path'
import { createLogger } from '../shared/logger'
import { pluginDevServer } from './plugin-dev-server'

const logger = createLogger('webcontents-view-manager')

/**
 * WebContentsView 管理器
 * 用于在主窗口中嵌入插件视图
 * 使用 LRU 缓存策略管理视图生命周期
 */
export class WebContentsViewManager {
  private views = new Map<string, WebContentsView>()
  private mainWindow: BrowserWindow | null = null
  private lruQueue: string[] = [] // LRU 队列，最近使用的在前面
  private maxCachedViews = 8 // 增加缓存数量到 8 个视图
  private currentVisiblePluginId: string | null = null // 当前可见的插件 ID
  private hiddenBySearch: string | null = null // 被搜索窗口临时隐藏的插件 ID
  private lastBounds = new Map<string, { x: number; y: number; width: number; height: number }>() // 缓存最后的 bounds，避免重复设置
  private sidebarCollapsed = false // 侧边栏是否收起
  private reloadTimers = new Map<string, ReturnType<typeof setTimeout>>() // autoReload 重试计时器
  private currentTheme: 'light' | 'dark' = 'light' // 缓存当前主题，避免每次跨 webContents 查询

  /**
   * 设置主窗口
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window

    // 监听主题变化事件，同时更新缓存
    ipcMain.on('theme-changed', (_event, theme: 'light' | 'dark') => {
      this.currentTheme = theme
      this.broadcastThemeChange(theme)
    })
  }

  /**
   * 设置侧边栏状态
   */
  setSidebarCollapsed(collapsed: boolean): void {
    this.sidebarCollapsed = collapsed
  }

  /**
   * 创建插件视图
   */
  createPluginView(pluginId: string, url: string): WebContentsView {
    // 如果已存在，更新 LRU 并返回
    if (this.views.has(pluginId)) {
      this.updateLRU(pluginId)
      return this.views.get(pluginId)!
    }

    // 检查是否超过缓存限制
    if (this.views.size >= this.maxCachedViews) {
      this.evictLRU()
    }

    // 创建新的 WebContentsView（性能优化）
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false, // 禁用 sandbox 以支持 preload
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        // 生产环境禁用开发者工具
        devTools: process.env.NODE_ENV === 'development',
        // 性能优化选项
        backgroundThrottling: false, // 禁用后台节流，保持插件响应
        offscreen: false, // 禁用离屏渲染
        enableWebSQL: false, // 禁用 WebSQL
        spellcheck: false // 禁用拼写检查
      }
    })

    // 在 URL 中添加插件 ID 参数
    const urlWithPluginId = url.includes('?')
      ? `${url}&__plugin_id=${pluginId}`
      : `${url}?__plugin_id=${pluginId}`

    // 加载插件 URL（异步，不阻塞）
    view.webContents.loadURL(urlWithPluginId).catch((err) => {
      // 忽略常见的非致命错误：
      // ERR_ABORTED (-3): 导航被取消
      // ERR_FAILED (-2): 通用失败，但页面可能已加载
      const ignoredErrors = ['ERR_ABORTED', 'ERR_FAILED']
      if (ignoredErrors.includes(err.code)) {
        return
      }
      logger.error({ err, pluginId }, '加载插件失败')
    })

    // 只在 dom-ready 时注入一次（更早且足够）
    view.webContents.once('dom-ready', () => {
      const script = `
        (function() {
          const params = new URLSearchParams(window.location.search);
          const pluginId = params.get('__plugin_id') || '${pluginId}';

          Object.defineProperty(window, '__UNIHUB_PLUGIN_ID__', {
            value: pluginId,
            writable: false,
            configurable: false
          });
        })();
      `

      view.webContents.executeJavaScript(script).catch((err) => {
        logger.error({ err }, '注入插件 ID 失败')
      })

      // 使用缓存的主题直接发送，避免跨 webContents 查询
      view.webContents.send('theme-changed', this.currentTheme)
    })

    // 开发模式下打开 DevTools（已禁用）
    // if (process.env.NODE_ENV === 'development') {
    //   view.webContents.openDevTools({ mode: 'detach' })
    // }

    // 监听控制台消息
    // 开发模式插件：直接输出到 stdout（方便开发者调试）
    // 其他：仅在 development 环境下通过 logger 记录
    const devConfig = pluginDevServer.getDevConfig(pluginId)
    if (devConfig) {
      const levelMap = ['debug', 'info', 'warn', 'error'] as const
      view.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        const tag = `\x1b[36m[Plugin:${pluginId}]\x1b[0m`
        const lvl = levelMap[level] || 'log'
        const src = sourceId ? ` (${sourceId}:${line})` : ''
        process.stdout.write(`${tag} [${lvl}] ${message}${src}\n`)
      })
    } else if (process.env.NODE_ENV === 'development') {
      view.webContents.on('console-message', (_event, _level, message) => {
        logger.info({ pluginId, message }, '[Plugin]')
      })
    }

    // 监听加载错误
    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3 || errorCode === -2) {
          return
        }
        logger.error({ pluginId, errorCode, errorDescription, validatedURL }, '[Plugin] 加载失败')

        // autoReload: dev 模式下自动重试
        if (devConfig?.autoReload) {
          logger.info({ pluginId }, '[Dev] 开发服务器连接失败，2s 后自动重试...')
          this.scheduleDevReload(pluginId, view)
        }
      }
    )

    // 拦截插件视图中的 Cmd+W / Ctrl+W 快捷键
    view.webContents.on('before-input-event', (event, input) => {
      // 检查是否是 Cmd+W (Mac) 或 Ctrl+W (Windows/Linux)
      if (input.type === 'keyDown' && input.key === 'w' && (input.meta || input.control)) {
        event.preventDefault()
        logger.info({ pluginId }, '阻止插件中的 Cmd+W 关闭窗口')
        // 通知主窗口的渲染进程处理关闭标签
        this.mainWindow?.webContents.send('handle-close-tab')
      }
    })

    this.views.set(pluginId, view)
    this.updateLRU(pluginId)
    return view
  }

  /**
   * 更新 LRU 队列
   */
  private updateLRU(pluginId: string): void {
    // 移除旧位置
    const index = this.lruQueue.indexOf(pluginId)
    if (index > -1) {
      this.lruQueue.splice(index, 1)
    }
    // 添加到队首（最近使用）
    this.lruQueue.unshift(pluginId)
  }

  /**
   * 驱逐最久未使用的视图
   */
  private evictLRU(): void {
    if (this.lruQueue.length === 0) return

    // 获取最久未使用的插件 ID（队尾）
    const oldestPluginId = this.lruQueue[this.lruQueue.length - 1]
    logger.info({ pluginId: oldestPluginId }, '🗑LRU 驱逐')
    this.removePluginView(oldestPluginId)
  }

  /**
   * 显示插件视图
   */
  showPluginView(
    pluginId: string,
    bounds?: { x: number; y: number; width: number; height: number }
  ): void {
    if (!this.mainWindow) {
      logger.error('主窗口未设置')
      return
    }

    const view = this.views.get(pluginId)
    if (!view) {
      logger.error({ pluginId }, '插件视图不存在')
      return
    }

    // 更新 LRU
    this.updateLRU(pluginId)

    // 记录当前可见的插件
    this.currentVisiblePluginId = pluginId

    // 添加到主窗口
    this.mainWindow.contentView.addChildView(view)

    // 设置位置和大小
    if (bounds) {
      view.setBounds(bounds)
    } else {
      // 默认填满内容区域（不覆盖侧边栏和标题栏）
      const windowBounds = this.mainWindow.getBounds()
      const sidebarWidth = this.sidebarCollapsed ? 48 : 208 // 侧边栏宽度：收起 48px (w-12)，展开 208px (w-52)
      const titleBarHeight = 36 // 标题栏高度 (h-9 = 2.25rem = 36px)

      view.setBounds({
        x: sidebarWidth,
        y: titleBarHeight,
        width: windowBounds.width - sidebarWidth,
        height: windowBounds.height - titleBarHeight
      })
    }

    // 发送插件可见性事件
    view.webContents.send('plugin-visibility-changed', true)
    logger.debug({ pluginId }, '插件已显示')

    // 聚焦到插件视图，确保键盘事件被正确捕获
    view.webContents.focus()
  }

  /**
   * 隐藏插件视图
   */
  hidePluginView(pluginId: string): void {
    if (!this.mainWindow) return

    const view = this.views.get(pluginId)
    if (!view) return

    // 发送插件可见性事件
    view.webContents.send('plugin-visibility-changed', false)
    logger.debug({ pluginId }, '插件已隐藏')

    this.mainWindow.contentView.removeChildView(view)

    // 如果隐藏的是当前可见的插件，清除记录
    if (this.currentVisiblePluginId === pluginId) {
      this.currentVisiblePluginId = null
    }
  }

  /**
   * 移除插件视图
   */
  removePluginView(pluginId: string): void {
    const view = this.views.get(pluginId)
    if (!view) return

    logger.info({ pluginId }, '🗑️ 销毁插件视图')

    // 先隐藏
    this.hidePluginView(pluginId)

    // 销毁 WebContents
    if (!view.webContents.isDestroyed()) {
      view.webContents.close()
    }

    this.views.delete(pluginId)

    // 清理 autoReload 计时器
    const timer = this.reloadTimers.get(pluginId)
    if (timer) {
      clearTimeout(timer)
      this.reloadTimers.delete(pluginId)
    }

    // 从 LRU 队列中移除
    const index = this.lruQueue.indexOf(pluginId)
    if (index > -1) {
      this.lruQueue.splice(index, 1)
    }

    // 确保焦点回到主窗口
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.focus()
    }
  }

  /**
   * 更新当前可见插件的视图布局（实时更新，用于动画过程）
   */
  updateCurrentPluginLayout(sidebarWidth: number, titleBarHeight: number): void {
    if (!this.mainWindow || !this.currentVisiblePluginId) return

    const view = this.views.get(this.currentVisiblePluginId)
    if (!view) return

    const windowBounds = this.mainWindow.getBounds()
    const newBounds = {
      x: sidebarWidth,
      y: titleBarHeight,
      width: windowBounds.width - sidebarWidth,
      height: windowBounds.height - titleBarHeight
    }

    // 使用 updatePluginViewBounds 来避免重复设置相同的 bounds
    this.updatePluginViewBounds(this.currentVisiblePluginId, newBounds)
  }

  /**
   * 更新插件视图位置（性能优化：避免重复设置相同的 bounds）
   */
  updatePluginViewBounds(
    pluginId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): void {
    const view = this.views.get(pluginId)
    if (!view) return

    // 检查 bounds 是否真的改变了
    const lastBounds = this.lastBounds.get(pluginId)
    if (
      lastBounds &&
      lastBounds.x === bounds.x &&
      lastBounds.y === bounds.y &&
      lastBounds.width === bounds.width &&
      lastBounds.height === bounds.height
    ) {
      return // 没有变化，跳过
    }

    view.setBounds(bounds)
    this.lastBounds.set(pluginId, bounds)
  }

  /**
   * 获取插件视图
   */
  getPluginView(pluginId: string): WebContentsView | undefined {
    return this.views.get(pluginId)
  }

  /**
   * 获取所有插件视图
   */
  getAllViews(): Map<string, WebContentsView> {
    return this.views
  }

  /**
   * 检查是否有活动的视图
   */
  hasActiveViews(): boolean {
    if (!this.mainWindow) return false

    // 检查是否有视图被添加到主窗口
    for (const view of this.views.values()) {
      // 简单检查：如果视图存在且未被销毁，认为是活动的
      if (!view.webContents.isDestroyed()) {
        return true
      }
    }
    return false
  }

  /**
   * 临时隐藏当前可见的插件（用于搜索窗口显示时）
   * 性能优化：将视图移到屏幕外而不是移除，避免重新添加时的开销
   */
  hideCurrentPluginForSearch(): void {
    if (this.currentVisiblePluginId) {
      const view = this.views.get(this.currentVisiblePluginId)
      if (!view) return

      logger.info({ pluginId: this.currentVisiblePluginId }, '临时隐藏插件（搜索窗口显示）')
      this.hiddenBySearch = this.currentVisiblePluginId

      // 性能优化：将视图移到屏幕外而不是移除
      // 这样可以避免重新添加视图时的布局计算和重绘
      // 设置一个很小的尺寸并移到屏幕外
      view.setBounds({ x: -10000, y: -10000, width: 1, height: 1 })
      logger.info('插件视图已移到屏幕外（性能优化）')

      // 确保主窗口获得焦点，以便能够接收键盘事件
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.focus()
        logger.info('主窗口 webContents 已获得焦点')
      }
    }
  }

  /**
   * 恢复被搜索窗口隐藏的插件
   * 性能优化：恢复视图位置而不是重新添加
   */
  restorePluginAfterSearch(): void {
    if (this.hiddenBySearch) {
      const view = this.views.get(this.hiddenBySearch)
      if (!view) {
        this.hiddenBySearch = null
        return
      }

      logger.info({ pluginId: this.hiddenBySearch }, '恢复插件（搜索窗口关闭）')

      // 性能优化：恢复视图位置
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        const windowBounds = this.mainWindow.getBounds()
        const sidebarWidth = this.sidebarCollapsed ? 48 : 208 // 侧边栏宽度：收起 48px (w-12)，展开 208px (w-52)
        const titleBarHeight = 36

        view.setBounds({
          x: sidebarWidth,
          y: titleBarHeight,
          width: windowBounds.width - sidebarWidth,
          height: windowBounds.height - titleBarHeight
        })
        logger.info('插件视图位置已恢复（性能优化）')
      }

      this.hiddenBySearch = null
    }
  }

  /**
   * 广播主题变化到所有插件视图
   */
  private broadcastThemeChange(theme: 'light' | 'dark'): void {
    logger.info({ theme }, '广播主题变化到所有插件')
    for (const [pluginId, view] of this.views) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.send('theme-changed', theme)
        logger.info({ pluginId, theme }, '已通知插件主题变化')
      }
    }
  }

  /**
   * 调度 dev 模式自动重载（延迟重试）
   */
  private scheduleDevReload(pluginId: string, view: WebContentsView): void {
    // 清除已有的计时器
    const existing = this.reloadTimers.get(pluginId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.reloadTimers.delete(pluginId)
      if (!view.webContents.isDestroyed()) {
        logger.info({ pluginId }, '[Dev] 尝试重新加载...')
        view.webContents.reloadIgnoringCache()
      }
    }, 2000)

    this.reloadTimers.set(pluginId, timer)
  }

  /**
   * 手动重载开发模式插件视图
   */
  reloadPluginView(pluginId: string): boolean {
    const view = this.views.get(pluginId)
    if (!view || view.webContents.isDestroyed()) return false
    view.webContents.reloadIgnoringCache()
    logger.info({ pluginId }, '手动重载插件视图')
    return true
  }

  /**
   * 清理所有视图
   */
  cleanup(): void {
    // 移除主题变化监听器
    ipcMain.removeAllListeners('theme-changed')

    for (const [pluginId] of this.views) {
      this.removePluginView(pluginId)
    }
  }
}

export const webContentsViewManager = new WebContentsViewManager()
