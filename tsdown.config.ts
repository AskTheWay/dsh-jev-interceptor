import { defineConfig } from 'tsdown'

// 基线模块表(浏览器模块表 PLATFORM_MODULES):必须保持 external。
const BASELINE = (id: string): boolean =>
  id === 'react' || id.startsWith('react/')
  || id === '@deepseek-ai/cordis' || id.startsWith('@deepseek-ai/cordis/')
  || id === '@deepseek-ai/dsh-client-store' || id.startsWith('@deepseek-ai/dsh-client-store/')
  || id === '@deepseek-ai/dsh-client-ui-slots' || id.startsWith('@deepseek-ai/dsh-client-ui-slots/')
  || id === '@deepseek-ai/dsh-client-ui-primitives' || id.startsWith('@deepseek-ai/dsh-client-ui-primitives/')

export default [
  // ---------- 宿主半(Node)----------
  defineConfig({
    entry: ['src/index.ts', 'src/session-reference.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  }),
  // ---------- 浏览器半 ----------
  // dsh 前端的插件加载协议要求 client bundle 为 CJS 闭包工厂。
  defineConfig({
    name: 'dsh-jev-interceptor/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    deps: {
      neverBundle: BASELINE,
      alwaysBundle: (id) => !BASELINE(id),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: () => 'window.__ModuleLoader__.load({ id: "dsh-jev-interceptor", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  }),
]
