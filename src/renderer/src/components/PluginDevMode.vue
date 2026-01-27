<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { toast } from 'vue-sonner'

const emit = defineEmits<{
  close: []
}>()

const activeTab = ref<'register' | 'guide'>('register')
const pluginId = ref('')
const devUrl = ref('http://localhost:5173')
const autoReload = ref(true)
const devPlugins = ref<Array<{ id: string; url: string; autoReload: boolean }>>([])
const loading = ref(false)

// 加载开发模式插件列表
const loadDevPlugins = async (): Promise<void> => {
  try {
    const result = await window.api.plugin.dev.list()
    if (result.success && result.data) {
      // 使用 unknown 中转，因为类型定义可能不匹配
      devPlugins.value = result.data as unknown as typeof devPlugins.value
    }
  } catch (error) {
    console.error('加载开发模式插件失败:', error)
  }
}

// 注册开发模式插件
const registerDevPlugin = async (): Promise<void> => {
  if (!pluginId.value.trim() || !devUrl.value.trim()) {
    toast.error('请填写插件 ID 和开发服务器 URL')
    return
  }

  loading.value = true

  try {
    const result = await window.api.plugin.dev.register(
      pluginId.value.trim(),
      devUrl.value.trim(),
      autoReload.value
    )

    if (result.success) {
      toast.success(`已注册开发模式: ${pluginId.value}`)
      pluginId.value = ''
      await loadDevPlugins()
    } else {
      toast.error(`注册失败: ${result.error}`)
    }
  } catch (error) {
    toast.error(`注册失败: ${error}`)
  } finally {
    loading.value = false
  }
}

// 取消注册开发模式插件
const unregisterDevPlugin = async (id: string): Promise<void> => {
  try {
    const result = await window.api.plugin.dev.unregister(id)
    if (result.success) {
      toast.success(`已取消开发模式: ${id}`)
      await loadDevPlugins()
    }
  } catch (error) {
    toast.error(`取消失败: ${error}`)
  }
}

onMounted(() => {
  loadDevPlugins()
})
</script>

<template>
  <Dialog :open="true" @update:open="(open) => !open && emit('close')">
    <DialogContent class="max-w-2xl max-h-[80vh] flex flex-col">
      <DialogHeader>
        <DialogTitle>插件开发模式</DialogTitle>
        <DialogDescription>
          在开发模式下，插件会直接加载开发服务器的内容，支持热重载
        </DialogDescription>
      </DialogHeader>

      <!-- Tab 切换 -->
      <div class="flex gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg">
        <button
          :class="[
            'flex-1 px-4 py-2 text-sm font-medium rounded-md transition-all',
            activeTab === 'register'
              ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
          ]"
          @click="activeTab = 'register'"
        >
          注册插件
        </button>
        <button
          :class="[
            'flex-1 px-4 py-2 text-sm font-medium rounded-md transition-all',
            activeTab === 'guide'
              ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
          ]"
          @click="activeTab = 'guide'"
        >
          使用指南
        </button>
      </div>

      <!-- 内容区域 - 添加滚动 -->
      <div class="flex-1 min-h-0 overflow-y-auto">
        <!-- 注册插件 Tab -->
        <div v-show="activeTab === 'register'" class="space-y-4 py-4">
          <!-- 注册表单 -->
          <div class="space-y-4">
            <div class="space-y-2">
              <label class="text-sm font-medium">插件 ID</label>
              <Input v-model="pluginId" placeholder="com.example.myplugin" :disabled="loading" />
              <p class="text-xs text-gray-500">
                插件的唯一标识符，需要与 package.json 中的 unihub.id 一致
              </p>
            </div>

            <div class="space-y-2">
              <label class="text-sm font-medium">开发服务器 URL</label>
              <Input v-model="devUrl" placeholder="http://localhost:5173" :disabled="loading" />
              <p class="text-xs text-gray-500">
                Vite 开发服务器的地址，通常是 http://localhost:5173
              </p>
            </div>

            <div class="flex items-center gap-2">
              <input
                id="autoReload"
                v-model="autoReload"
                type="checkbox"
                class="w-4 h-4"
                :disabled="loading"
              />
              <label for="autoReload" class="text-sm"> 自动重载（文件变化时自动刷新） </label>
            </div>

            <Button :disabled="loading" class="w-full" @click="registerDevPlugin">
              {{ loading ? '注册中...' : '注册开发模式' }}
            </Button>
          </div>

          <!-- 已注册的开发模式插件 -->
          <div v-if="devPlugins.length > 0" class="border-t pt-4">
            <h3 class="text-sm font-semibold mb-3">已注册的开发模式插件</h3>
            <div class="space-y-2 max-h-48 overflow-y-auto">
              <div
                v-for="plugin in devPlugins"
                :key="plugin.id"
                class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
              >
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <Badge variant="secondary" class="text-xs">DEV</Badge>
                    <span class="text-sm font-medium truncate">{{ plugin.id }}</span>
                  </div>
                  <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                    {{ plugin.url }}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  class="ml-2"
                  @click="unregisterDevPlugin(plugin.id)"
                >
                  取消
                </Button>
              </div>
            </div>
          </div>
        </div>

        <!-- 使用指南 Tab -->
        <div v-show="activeTab === 'guide'" class="py-4 space-y-4">
          <div class="space-y-3">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100">快速开始</h3>
            <ol class="space-y-3 text-sm text-gray-700 dark:text-gray-300">
              <li class="flex gap-3">
                <span
                  class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 text-xs font-semibold"
                >
                  1
                </span>
                <div class="flex-1">
                  <p class="font-medium mb-1">启动开发服务器</p>
                  <p class="text-xs text-gray-600 dark:text-gray-400 mb-2">
                    在插件项目目录中运行：
                  </p>
                  <code
                    class="block px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono"
                  >
                    npm run dev
                  </code>
                </div>
              </li>

              <li class="flex gap-3">
                <span
                  class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 text-xs font-semibold"
                >
                  2
                </span>
                <div class="flex-1">
                  <p class="font-medium mb-1">注册开发模式</p>
                  <p class="text-xs text-gray-600 dark:text-gray-400">
                    切换到"注册插件"标签，填写插件 ID 和开发服务器 URL，然后点击"注册开发模式"
                  </p>
                </div>
              </li>

              <li class="flex gap-3">
                <span
                  class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 text-xs font-semibold"
                >
                  3
                </span>
                <div class="flex-1">
                  <p class="font-medium mb-1">打开插件</p>
                  <p class="text-xs text-gray-600 dark:text-gray-400">
                    在主界面打开插件，即可看到开发服务器的实时内容
                  </p>
                </div>
              </li>

              <li class="flex gap-3">
                <span
                  class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 text-xs font-semibold"
                >
                  4
                </span>
                <div class="flex-1">
                  <p class="font-medium mb-1">开始开发</p>
                  <p class="text-xs text-gray-600 dark:text-gray-400">
                    修改代码后，插件会自动刷新（如果启用了自动重载）
                  </p>
                </div>
              </li>
            </ol>
          </div>

          <div class="border-t pt-4 space-y-3">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100">常见问题</h3>
            <div class="space-y-3 text-sm">
              <div>
                <p class="font-medium text-gray-900 dark:text-gray-100 mb-1">
                  Q: 插件 ID 在哪里找？
                </p>
                <p class="text-xs text-gray-600 dark:text-gray-400">
                  A: 在插件项目的 package.json 文件中，查找 unihub.id 字段
                </p>
              </div>

              <div>
                <p class="font-medium text-gray-900 dark:text-gray-100 mb-1">
                  Q: 开发服务器 URL 是什么？
                </p>
                <p class="text-xs text-gray-600 dark:text-gray-400">
                  A: 通常是 http://localhost:5173（Vite 默认端口），具体端口号请查看终端输出
                </p>
              </div>

              <div>
                <p class="font-medium text-gray-900 dark:text-gray-100 mb-1">Q: 自动重载是什么？</p>
                <p class="text-xs text-gray-600 dark:text-gray-400">
                  A: 启用后，当你修改代码时，插件会自动刷新显示最新内容，无需手动刷新
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('close')">关闭</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
