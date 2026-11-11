/** Browser panel registration: main content and a sidebar icon, backed by the host /api/jev-interceptor routes. */

import { t, bindLocale } from './i18n.js'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { JevPage, injectPanelCss } from './JevPage.js'
import { JevPanelIcon } from './JevPanelIcon.js'

export const NS = 'jevInterceptor'

export const PANEL_ID = 'jev-interceptor' as MainPanelId

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  // One language for the whole GUI: the panel reads and switches the platform
  // locale, whose Host-persisted preference the plugin's server half follows.
  ctx.effect(() => bindLocale(ctx.locale), 'jev-interceptor: locale binding')
  // Inject CSS once using the official data-plugin-css convention.
  // CSS classes and theme tokens support hover, focus, and responsive styles.
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
    label: () => t('panel.jevDecisions'),
    locale: NS,
  }, JevPanelIcon))
}
