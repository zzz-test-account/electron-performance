import { createRouter, createWebHashHistory } from 'vue-router';
import Dashboard from './views/Dashboard.vue';

/**
 * 当前仅一个视图；路由保留是为了后续扩展（性能看板、归档管理等页面）
 * 不改动应用骨架。Electron 打包后用 hash 模式避免 file:// 路径问题。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/', name: 'dashboard', component: Dashboard }],
});
