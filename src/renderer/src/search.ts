import './style.css'

import { createApp } from 'vue'
import SearchWindow from './pages/SearchWindow.vue'
import { initPlugins } from './plugins'
import { pluginInstaller } from './plugins/marketplace/installer'

const app = createApp(SearchWindow)

initPlugins()

pluginInstaller.loadInstalledPlugins().catch((error) => {
  console.error('加载插件失败:', error)
})

app.mount('#app')
