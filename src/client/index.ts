/**
 * Jev Interceptor 侧栏设置面板（浏览器半）。
 *
 * 结构照 dsh-auto-memory 样板:全局面板挂 main slot,侧栏图标挂
 * sidebar.panellist;数据经宿主半 /api/jev-interceptor/* 路由 fetch 获取。
 *
 * 样式内联(官方 CSS Modules 管线未随 preset 发布);控件用原生元素。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { JevPage, injectPanelCss } from './JevPage.tsx'
import { JevPanelIcon } from './JevPanelIcon.tsx'

export const NS = 'jevInterceptor'

export const PANEL_ID = 'jev-interceptor' as MainPanelId

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  // 样式注入（官方 client bundle 的 data-plugin-css 约定，幂等）：内联 style
  // 没有 hover/focus/媒体查询能力，面板视觉层走真 CSS 类与主题 token。
  injectPanelCss()
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, JevPage))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 51,
    label: () => 'Jev 决策',
    locale: NS,
  }, JevPanelIcon))
}
