/**
 * dsh-jev-interceptor 浏览器端遥测面板。
 *
 * 通过 window.__ModuleLoader__.load() 注册为 DSH 客户端模块（与 dsh-chat-width
 * 同一机制），在 Settings 页面的 Plugins 区域渲染遥测摘要卡片：
 *
 *   - 决策调用数 / 降级率 / 缓存命中率
 *   - 动作分布（deny/ask/delegate/auto-approve）
 *   - 延迟 p50/p95
 *   - 成本估算
 *   - approval-loop 一致率（would-over-approve 等五桶）
 *
 * 数据获取：从 <dsh-jev-interceptor-data> 自定义元素读 host 侧注入的 JSON
 * （host 侧 apply() 在挂载时把 telemetry.stats() 的结果写进 dataset），
 * 每次 Settings 页打开时刷新。
 *
 * 纯 DOM 操作，无 React/TSX 依赖，兼容所有 dsh Web 版本。
 */
window.__ModuleLoader__.load({
  id: "dsh-jev-interceptor-dashboard",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var REFRESH_INTERVAL_MS = 30000;
    var timer = null;
    var container = null;

    // ── 工具函数 ──────────────────────────────────────────────────────────

    function esc(text) {
      var div = document.createElement("div");
      div.textContent = String(text);
      return div.innerHTML;
    }

    function statCard(title, value, sub) {
      return '<div style="flex:1;min-width:120px;padding:12px 16px;border:1px solid var(--border,#e2e8f0);border-radius:8px;background:var(--surface,#fff)">'
        + '<div style="font-size:12px;color:var(--muted,#64748b);margin-bottom:4px">' + esc(title) + "</div>"
        + '<div style="font-size:24px;font-weight:600;color:var(--text,#1e293b)">' + esc(value) + "</div>"
        + (sub ? '<div style="font-size:11px;color:var(--muted,#94a3b8);margin-top:2px">' + esc(sub) + "</div>" : "")
        + "</div>";
    }

    function tagSection(tag, lines) {
      var html = '<div style="margin-bottom:16px">';
      html += '<div style="font-size:13px;font-weight:600;color:var(--text,#1e293b);margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border,#e2e8f0)">[' + esc(tag) + "]</div>";
      html += '<div style="display:flex;flex-wrap:wrap;gap:8px">' + lines + "</div>";
      html += "</div>";
      return html;
    }

    // ── 从 host 侧读取遥测数据 ────────────────────────────────────────────

    var LS_KEY = "dsh-jev-interceptor:stats";

    function readHostData() {
      // v1 数据桥：从 localStorage 读取 /jev-stats 命令最近一次的输出
      // （host 侧 command handler 通过 MutationObserver 截获命令渲染写入）。
      // 后续版本可升级为 typert remote 直连。
      try {
        var raw = localStorage.getItem(LS_KEY);
        if (raw === null) return null;
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    }

    function parseStatsText(text) {
      // /jev-stats 的文本输出解析成结构化数据用于面板渲染
      if (typeof text !== "string") return [];
      var sections = [];
      var current = null;
      for (var line of text.split("\n")) {
        var tagMatch = line.match(/^\[(.+?)\]\s+(.+)/);
        if (tagMatch !== null) {
          current = { tag: tagMatch[1], summary: tagMatch[2], details: [] };
          sections.push(current);
          continue;
        }
        if (current !== null && line.trim().length > 0) {
          current.details.push(line.trim());
        }
      }
      return sections;
    }

    // ── 渲染面板 ──────────────────────────────────────────────────────────

    function renderDashboard(target) {
      var hostData = readHostData();
      var sections = hostData !== null ? hostData : [];

      var html = '<div style="padding:16px;border:1px solid var(--border,#e2e8f0);border-radius:12px;background:var(--bg,#f8fafc)">';

      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">';
      html += '<span style="font-size:18px">⚡</span>';
      html += '<span style="font-size:15px;font-weight:600;color:var(--text,#1e293b)">dsh-jev-interceptor</span>';
      html += '<span style="font-size:11px;color:var(--muted,#94a3b8)">决策遥测</span>';
      html += '<span style="margin-left:auto;font-size:11px;color:var(--muted,#94a3b8)">自动刷新 30s</span>';
      html += "</div>";

      if (sections.length === 0) {
        html += '<div style="text-align:center;padding:24px;color:var(--muted,#94a3b8);font-size:13px">暂无决策记录。运行 <code style="padding:2px 6px;border-radius:4px;background:var(--code-bg,#e2e8f0)">/jev-on</code> 启用插件后再来查看。</div>';
      } else {
        for (var _i = 0, sections_1 = sections; _i < sections_1.length; _i++) {
          var sec = sections_1[_i];
          var cards = [];
          // 解析 summary："调用 N 次 降级 X 缓存命中 Y"
          var callMatch = sec.summary.match(/调用\s*(\d+)\s*次/);
          if (callMatch !== null) cards.push(statCard("调用", callMatch[1] + " 次", sec.tag));
          var degMatch = sec.summary.match(/降级\s*(\d+)/);
          if (degMatch !== null) cards.push(statCard("降级", degMatch[1]));
          var cacheMatch = sec.summary.match(/缓存命中\s*(\d+)/);
          if (cacheMatch !== null) cards.push(statCard("缓存命中", cacheMatch[1]));
          // 从 details 提取延迟和一致率
          for (var _a = 0, _b = sec.details; _a < _b.length; _a++) {
            var d = _b[_a];
            var latMatch = d.match(/p50\s*(\d+)ms\s*p95\s*(\d+)ms/);
            if (latMatch !== null) cards.push(statCard("延迟", latMatch[1] + "ms", "p95 " + latMatch[2] + "ms"));
            var costMatch = d.match(/预计成本:\s*\$([\d.]+)/);
            if (costMatch !== null) cards.push(statCard("成本", "$" + costMatch[1]));
          }
          if (cards.length > 0) html += tagSection(sec.tag, cards.join(""));
          // 一致率行
          for (var _c = 0, _d = sec.details; _c < _d.length; _c++) {
            var d = _d[_c];
            if (d.indexOf("一致率:") !== -1 || d.indexOf("agreement:") !== -1) {
              html += '<div style="padding:8px 12px;border-radius:6px;background:var(--info-bg,#eff6ff);border:1px solid var(--info-border,#bfdbfe);font-size:12px;color:var(--text,#1e293b);margin-bottom:12px">' + esc(d) + "</div>";
            }
          }
        }
      }

      html += '<div style="text-align:right;font-size:10px;color:var(--muted,#cbd5e1);margin-top:8px">详细数据: /jev-stats</div>';
      html += "</div>";
      target.innerHTML = html;
    }

    // ── apply：挂载、MutationObserver 找 Settings 页 ─────────────────────

    function apply(ctx) {
      // host 侧注入数据容器（不存在则创建）
      var dataEl = document.getElementById("dsh-jev-interceptor-data");
      if (dataEl === null) {
        dataEl = document.createElement("div");
        dataEl.id = "dsh-jev-interceptor-data";
        dataEl.style.display = "none";
        document.body.appendChild(dataEl);
      }

      container = document.createElement("div");
      container.id = "dsh-jev-interceptor-dashboard";
      container.style.cssText = "margin:12px 0";

      // MutationObserver 等 Settings → Plugins 区域出现
      var observer = new MutationObserver(function () {
        var pluginsArea = document.querySelector("[data-settings-plugins]") || document.querySelector("#settings-plugins") || document.querySelector(".settings-plugins");
        if (pluginsArea !== null && document.getElementById("dsh-jev-interceptor-dashboard") === null) {
          pluginsArea.appendChild(container);
          renderDashboard(container);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      // 定时刷新
      timer = setInterval(function () {
        if (container !== null && container.isConnected) renderDashboard(container);
      }, REFRESH_INTERVAL_MS);

      // 清理
      return function () {
        observer.disconnect();
        if (timer !== null) clearInterval(timer);
        if (container !== null && container.parentNode !== null) container.parentNode.removeChild(container);
      };
    }

    exports.isPlugin = true;
    exports.inject = [];
    exports.apply = apply;
    exports.__setStats = function (text) {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(parseStatsText(text)));
      } catch (e) {
        // localStorage 可能不可用（隐私模式），面板静默降级
      }
      if (container !== null && container.isConnected) renderDashboard(container);
    };

    // 拦截 /jev-stats 命令的聊天渲染，自动提取文本写入 localStorage
    var chatObserver = new MutationObserver(function () {
      var messages = document.querySelectorAll("[data-message-text], .message-text, [class*='message']");
      for (var i = messages.length - 1; i >= 0; i--) {
        var text = messages[i].textContent || "";
        if (text.indexOf("dsh-jev-interceptor") !== -1 && text.indexOf("调用") !== -1) {
          try {
            localStorage.setItem(LS_KEY, JSON.stringify(parseStatsText(text)));
          } catch (e) {}
          break;
        }
      }
    });

    // 在 apply 里启动 chatObserver
    var originalApply = apply;
    apply = function (ctx) {
      var cleanup = originalApply(ctx);
      chatObserver.observe(document.body, { childList: true, subtree: true });
      return function () {
        chatObserver.disconnect();
        if (cleanup) cleanup();
      };
    };
    return module.exports;
  },
});
