import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { JevPage, injectPanelCss } from '../../src/client/JevPage.js'

injectPanelCss()

function Preview(): React.JSX.Element {
  const [theme, setTheme] = useState('light')
  const [width, setWidth] = useState('100%')
  const [scenario, setScenario] = useState('populated')
  const [version, setVersion] = useState(0)
  return (
    <div className="preview-shell">
      <div className="preview-controls">
        <b>界面预览</b>
        <span>演示数据，所有操作与真实宿主隔离</span>
        <label>
          主题
          <select
            aria-label="预览主题"
            value={theme}
            onChange={(event) => {
              const next = event.target.value
              setTheme(next)
              document.documentElement.dataset.theme = next
            }}
          >
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label>
          宽度
          <select
            aria-label="预览宽度"
            value={width}
            onChange={(event) => {
              setWidth(event.target.value)
            }}
          >
            <option value="100%">全宽</option>
            <option value="960px">960 px</option>
            <option value="760px">760 px</option>
            <option value="390px">390 px</option>
            <option value="320px">320 px</option>
          </select>
        </label>
        <label>
          场景
          <select
            aria-label="预览场景"
            value={scenario}
            onChange={async (event) => {
              const next = event.target.value
              setScenario(next)
              await fetch('/__preview/scenario', { method: 'POST', body: JSON.stringify({ scenario: next }) })
              setVersion(version + 1)
            }}
          >
            <option value="populated">已有记录</option>
            <option value="shadow">观察模式</option>
            <option value="empty">首次使用</option>
            <option value="offline">连接中断</option>
            <option value="partial">部分数据失败</option>
            <option value="save-error">保存失败</option>
          </select>
        </label>
      </div>
      <main className="preview-canvas" style={{ maxWidth: width }} key={version}>
        <JevPage {...({} as Parameters<typeof JevPage>[0])} />
      </main>
    </div>
  )
}

createRoot(document.getElementById('preview-root')!).render(<Preview />)
