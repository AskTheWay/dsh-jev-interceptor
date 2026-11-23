/** Scoped CSS follows the host surfaces; semantic ink stays distinct in both themes. */
export const PANEL_CSS = `
.jev-root{
  --j-text:var(--dsw-alias-label-primary,#202b3b);--j-muted:var(--dsw-alias-label-secondary,#657184);
  --j-base:var(--dsw-alias-bg-base,#f6f8fa);--j-surface:var(--dsw-alias-bg-layer-1,#fff);
  --j-soft:var(--dsw-alias-bg-layer-2,#f0f3f6);--j-line:var(--dsw-alias-border-l1,#e2e7ec);
  --j-brand:color-mix(in srgb,#4274c9 82%,var(--j-text));--j-ok:color-mix(in srgb,#169b80 65%,var(--j-text));
  --j-warn:color-mix(in srgb,#d89929 62%,var(--j-text));--j-err:color-mix(in srgb,#de6370 72%,var(--j-text));
  --j-business:color-mix(in srgb,#9274cf 72%,var(--j-text));
  box-sizing:border-box;container:jev / inline-size;width:100%;height:100%;min-height:0;max-height:100dvh;
  display:flex;flex-direction:column;overflow:hidden;background:var(--j-base);color:var(--j-text);
  font-family:var(--ds-font-family-ui,"Segoe UI","Microsoft YaHei",sans-serif);font-size:13px;line-height:1.6;
}
.jev-root *{box-sizing:border-box;}
.jev-root button,.jev-root input,.jev-root select{font:inherit;}
.jev-root button{cursor:pointer;}
.jev-root button:disabled{opacity:.45;cursor:default;}
.jev-root :is(button,input,select,[tabindex]):focus-visible{outline:2px solid var(--j-brand);outline-offset:3px;}
.jev-root input[type=checkbox]{accent-color:var(--j-brand);}
.jev-head{display:flex;align-items:center;gap:12px;padding:22px 30px 18px;flex:none;}
.jev-logo{width:40px;height:40px;display:grid;place-items:center;border-radius:12px;background:#167d72;color:#fff;}
.jev-headtext{flex:1;min-width:0;}
.jev-title-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;}
.jev-title{font-size:19px;font-weight:650;letter-spacing:-.4px;line-height:1.35;margin:0;}
.jev-sub,.jev-note,.jev-card-sub{color:var(--j-muted);font-size:12px;line-height:1.65;}
.jev-sub{margin-top:3px;}.jev-note{margin:0;overflow-wrap:anywhere;}
.jev-head-actions{display:flex;gap:8px;align-items:center;}
.jev-status{display:inline-flex;align-items:center;gap:7px;color:var(--j-muted);font-size:11px;white-space:nowrap;}
.jev-status[data-on="1"]{color:var(--j-ok);}.jev-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;}
.jev-btn{display:inline-flex;justify-content:center;align-items:center;gap:6px;min-height:33px;padding:5px 12px;border:1px solid var(--j-line);border-radius:7px;background:var(--j-surface);color:var(--j-text);white-space:nowrap;transition:background .15s,border-color .15s;}
.jev-btn:hover:not(:disabled){border-color:var(--j-brand);background:color-mix(in srgb,var(--j-brand) 7%,var(--j-surface));}
.jev-btn--primary{background:#376ab5;color:#fff;border-color:#376ab5;}
.jev-btn--primary:hover:not(:disabled){background:#2c5796;}
.jev-btn--quiet{background:transparent;border-color:transparent;color:var(--j-muted);}
.jev-runbar{display:flex;align-items:center;gap:16px;padding:9px 30px;background:var(--j-surface);border-block:1px solid var(--j-line);flex-wrap:wrap;flex:none;font-size:12px;}
.jev-runbar>span{display:inline-flex;align-items:center;gap:7px;}.jev-runbar small{font-size:11px;color:var(--j-muted);}
.jev-runbar .jev-seg{margin-left:auto;}.jev-runbar .jev-run-model{color:var(--j-muted);}
.jev-seg{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--j-line);border-radius:7px;background:var(--j-base);}
.jev-seg>button{border:0;border-radius:4px;background:transparent;color:var(--j-muted);padding:3px 11px;min-height:26px;font-size:12px;white-space:nowrap;}
.jev-seg>button[data-on="1"]{background:var(--j-surface);color:var(--j-brand);box-shadow:0 1px 3px #00000010;font-weight:600;}
.jev-tabs{display:flex;align-items:center;padding:0 30px;gap:26px;border-bottom:1px solid var(--j-line);flex:none;}
.jev-tab{display:inline-flex;align-items:center;gap:7px;position:relative;padding:15px 0 13px;border:0;color:var(--j-muted);background:transparent;font-size:13px;white-space:nowrap;}
.jev-tab[data-on="1"]{color:var(--j-text);font-weight:600;}.jev-tab[data-on="1"]::after{content:"";position:absolute;bottom:-1px;left:0;right:0;height:3px;background:var(--j-ok);border-radius:3px 3px 0 0;}
.jev-tab-count{padding:0 6px;border-radius:4px;background:var(--j-soft);font-size:10px;line-height:18px;font-weight:500;color:var(--j-muted);}
.jev-live{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--j-muted);white-space:nowrap;}
.jev-live .jev-dot{color:var(--j-ok);}
.jev-tab-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scroll-padding-bottom:90px;padding:24px 30px 32px;}
.jev-page{display:flex;flex-direction:column;gap:20px;max-width:1440px;margin:0 auto;}
.jev-section-head{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;}
.jev-section-head h3{margin:0;font-size:17px;line-height:1.5;font-weight:600;letter-spacing:-.3px;}
.jev-section-head p{margin:3px 0 0;font-size:12px;color:var(--j-muted);}
.jev-scope{color:var(--j-muted);font-size:11px;white-space:nowrap;}
.jev-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;}
.jev-kpi{padding:15px 17px 13px;border:1px solid var(--j-line);border-radius:9px;background:var(--j-surface);position:relative;min-width:0;overflow:hidden;}
.jev-kpi:before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:var(--k-color,var(--j-brand));}
.jev-kpi[data-tone="ok"]{--k-color:var(--j-ok);}.jev-kpi[data-tone="warn"]{--k-color:var(--j-warn);}.jev-kpi[data-tone="err"]{--k-color:var(--j-err);}.jev-kpi[data-tone="muted"]{--k-color:var(--j-muted);}
.jev-kpi-label{display:flex;align-items:center;gap:6px;color:var(--j-muted);font-size:12px;}
.jev-kpi b{display:block;font-size:29px;line-height:1.25;font-weight:650;letter-spacing:-.7px;font-variant-numeric:tabular-nums;margin:10px 0 5px;color:var(--k-color,var(--j-brand));}
.jev-kpi small{font-size:11px;color:var(--j-muted);line-height:1.4;display:block;}
.jev-overview-main{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(280px,1fr);gap:16px;}
.jev-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;}
.jev-tag-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;}
.jev-card{background:var(--j-surface);border:1px solid var(--j-line);border-radius:10px;padding:18px 20px;display:flex;flex-direction:column;gap:14px;min-width:0;}
.jev-card-head{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;}.jev-card-title{font-size:13px;font-weight:600;line-height:1.6;}.jev-card-sub{font-size:11px;margin-top:2px;}
.jev-card-metrics{margin-left:auto;color:var(--j-muted);font-size:11px;text-align:right;line-height:1.7;font-variant-numeric:tabular-nums;}
.jev-card--impact{border-top:3px solid var(--j-ok);}.jev-impact-values{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:3px 0 13px;border-bottom:1px solid var(--j-line);}
.jev-impact-values b{display:block;font-size:25px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.3;}.jev-impact-values span{font-size:11px;color:var(--j-muted);}
.jev-fact{display:flex;align-items:center;gap:10px;justify-content:space-between;font-size:12px;color:var(--j-muted);}.jev-fact>b{font-weight:500;color:var(--j-text);min-width:0;overflow-wrap:anywhere;text-align:right;}
.jev-impact-facts{display:flex;flex-direction:column;gap:7px;}
.jev-chips{display:flex;gap:7px;align-items:center;flex-wrap:wrap;}
.jev-badge{display:inline-flex;align-items:center;font-size:11px;line-height:19px;padding:0 7px;border:1px solid transparent;border-radius:5px;white-space:nowrap;font-variant-numeric:tabular-nums;}
.jev-toast,.jev-banner{display:flex;align-items:center;gap:8px;border:1px solid var(--j-line);border-radius:7px;padding:10px 13px;font-size:12px;line-height:1.6;}
.jev-feedback{margin:10px 30px 0;flex:none;}.jev-toast[data-tone="ok"]{color:var(--j-ok);background:color-mix(in srgb,var(--j-ok) 8%,var(--j-surface));}
.jev-toast[data-tone="err"]{color:var(--j-err);background:color-mix(in srgb,var(--j-err) 8%,var(--j-surface));}.jev-toast[data-tone="warn"],.jev-banner{color:var(--j-warn);background:color-mix(in srgb,var(--j-warn) 7%,var(--j-surface));}
.jev-banner button{margin-left:auto;}.jev-stack{display:flex;height:7px;border-radius:3px;overflow:hidden;background:var(--j-soft);gap:2px;}.jev-stack>i{display:block;height:100%;}
.jev-legend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;}.jev-legend>li{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--j-muted);min-width:0;}
.jev-swatch{width:7px;height:7px;border-radius:2px;flex:none;display:inline-block;}.jev-legend-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.jev-legend>li>b{font-weight:500;color:var(--j-text);font-variant-numeric:tabular-nums;}.jev-legend-pct{width:36px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;}
.jev-chart{display:flex;gap:10px;margin-top:8px;}.jev-chart-axis{height:154px;display:flex;flex-direction:column;justify-content:space-between;color:var(--j-muted);font-size:10px;width:27px;flex:none;text-align:right;}
.jev-chart-body{flex:1;min-width:0;}.jev-chart-bars{height:154px;display:flex;align-items:flex-end;gap:8px;border-bottom:1px solid var(--j-line);background:repeating-linear-gradient(to top,transparent 0,transparent calc(50% - 1px),var(--j-line) calc(50% - 1px),var(--j-line) 50%);}
.jev-chart-bar{position:relative;flex:1;height:100%;display:flex;align-items:center;justify-content:flex-end;flex-direction:column;gap:1px;min-width:0;}
.jev-chart-bar>i{width:100%;max-width:24px;min-width:3px;display:block;border-radius:2px 2px 0 0;}.jev-chart-bar:hover{background:color-mix(in srgb,var(--j-brand) 7%,transparent);}
.jev-chart-bar:focus-visible{outline-offset:0;}.jev-chart-tooltip{display:none;position:absolute;z-index:3;bottom:100%;left:50%;transform:translateX(-50%);background:var(--j-text);color:var(--j-base);padding:6px 9px;border-radius:5px;font-size:11px;white-space:nowrap;}
.jev-chart-bar:is(:hover,:focus-visible) .jev-chart-tooltip{display:block;}.jev-chart-ticks{display:flex;gap:8px;margin-top:7px;font-size:10px;color:var(--j-muted);}.jev-chart-ticks>span{flex:1;min-width:0;text-align:center;white-space:nowrap;}
.jev-chart-legend{display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--j-muted);}.jev-chart-legend>span{display:inline-flex;align-items:center;gap:5px;}
.jev-tool-row{display:grid;grid-template-columns:minmax(70px,125px) minmax(20px,1fr) 32px;gap:12px;align-items:center;border:0;background:transparent;color:var(--j-text);text-align:left;padding:5px 0;}
.jev-tool-row:hover{color:var(--j-brand);}.jev-tool-bar{height:7px;display:flex;overflow:hidden;border-radius:3px;}.jev-tool-bar>i{height:100%;}.jev-tool-row>b{text-align:right;font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;}
.jev-filterbox{display:flex;flex-direction:column;gap:12px;padding:16px;background:var(--j-surface);border:1px solid var(--j-line);border-radius:9px;}.jev-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.jev-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--j-muted);padding:5px 10px;min-height:31px;font-size:12px;}
.jev-chip:hover{background:var(--j-soft);}.jev-chip[data-on="1"]{color:var(--j-brand);background:color-mix(in srgb,var(--j-brand) 9%,var(--j-surface));border-color:color-mix(in srgb,var(--j-brand) 22%,transparent);}
.jev-chip>b{font-size:10px;font-weight:500;opacity:.8;}.jev-search-wrap{position:relative;flex:1;min-width:190px;display:flex;align-items:center;color:var(--j-muted);}.jev-search-wrap>svg{position:absolute;left:10px;}
.jev-search,.jev-input,.jev-select{border:1px solid var(--j-line);background:var(--j-base);color:var(--j-text);border-radius:6px;padding:7px 10px;min-height:34px;outline:none;min-width:0;}
.jev-search{width:100%;}.jev-search-wrap .jev-search{padding-left:33px;}.jev-search:focus,.jev-input:focus,.jev-select:focus{border-color:var(--j-brand);}.jev-input{width:100%;}
.jev-table{border:1px solid var(--j-line);border-radius:9px;background:var(--j-surface);overflow:hidden;}.jev-thead,.jev-row{display:grid;grid-template-columns:102px 88px minmax(90px,1fr) 99px 70px 58px minmax(120px,1.5fr) 14px;gap:12px;align-items:center;padding:11px 16px;}
.jev-thead{background:var(--j-soft);color:var(--j-muted);font-size:11px;}.jev-row{font-size:12px;border-top:1px solid var(--j-line);cursor:pointer;}
.jev-row:hover{background:color-mix(in srgb,var(--j-brand) 4%,var(--j-surface));}.jev-row[data-open="1"]{background:color-mix(in srgb,var(--j-brand) 5%,var(--j-surface));}
.jev-row-chevron{display:inline-flex;transition:transform .15s;}.jev-row[data-open="1"]>.jev-row-chevron{transform:rotate(90deg);}.jev-cell{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.jev-time{font-variant-numeric:tabular-nums;color:var(--j-muted);font-size:11px;}.jev-time>i{font-style:normal;display:block;font-size:10px;opacity:.8;}
.jev-mono{font-family:var(--ds-font-family-code,"Cascadia Code",Consolas,monospace);font-size:.95em;}.jev-num{font-variant-numeric:tabular-nums;color:var(--j-muted);}.jev-strong{color:var(--j-text);}.jev-detail{color:var(--j-muted);font-size:11px;}
.jev-detail-full{grid-column:1/-1;padding:15px 0 3px;margin-top:5px;border-top:1px dashed var(--j-line);cursor:default;display:flex;flex-direction:column;gap:16px;}
.jev-detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 20px;}.jev-kv{display:flex;flex-direction:column;gap:2px;min-width:0;font-size:11px;}.jev-kv>span{color:var(--j-muted);}.jev-kv>b{font-weight:500;overflow-wrap:anywhere;}
.jev-evidence{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 20px;}.jev-score-label{display:flex;justify-content:space-between;font-size:11px;margin-bottom:5px;color:var(--j-muted);}.jev-score-track{height:4px;border-radius:2px;background:var(--j-line);}.jev-score-track>i{display:block;height:100%;background:var(--j-brand);border-radius:2px;}
.jev-raw{background:var(--j-base);border:1px solid var(--j-line);border-radius:6px;padding:10px 12px;margin:0;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--j-muted);}
.jev-pagination{position:sticky;bottom:-1px;z-index:2;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;background:var(--j-base);padding:12px 0;border-top:1px solid var(--j-line);}.jev-pagination-nav{display:flex;gap:5px;align-items:center;flex-wrap:wrap;}
.jev-mini{list-style:none;margin:0;padding:0;}.jev-mini>li{border-top:1px solid var(--j-line);}.jev-mini>li:first-child{border:0;}.jev-mini-button{display:grid;grid-template-columns:78px minmax(70px,125px) 100px minmax(80px,1fr) 14px;align-items:center;gap:12px;width:100%;border:0;background:transparent;color:var(--j-text);text-align:left;padding:10px 0;}
.jev-mini-button:hover{color:var(--j-brand);}.jev-mini-button>.jev-detail{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.jev-field{display:flex;flex-direction:column;gap:7px;}.jev-field-label{color:var(--j-muted);font-size:12px;}.jev-provider{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;}
.jev-provider>button{position:relative;text-align:left;border:1px solid var(--j-line);background:var(--j-base);border-radius:7px;padding:12px 10px;color:var(--j-text);}
.jev-provider>button[data-on="1"]{border-color:var(--j-brand);background:color-mix(in srgb,var(--j-brand) 6%,var(--j-surface));}.jev-provider>button[data-on="1"]::after{content:"✓";position:absolute;right:8px;top:7px;font-size:11px;color:var(--j-brand);}
.jev-provider b{font-size:12px;display:block;margin-bottom:4px;}.jev-provider span{display:block;font-size:10px;color:var(--j-muted);line-height:1.6;}
.jev-empty{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;border:1px dashed var(--j-line);border-radius:9px;background:var(--j-surface);padding:35px 20px;color:var(--j-muted);font-size:12px;}.jev-empty b{font-size:14px;color:var(--j-text);font-weight:600;}.jev-empty>svg{color:var(--j-brand);margin-bottom:4px;}.jev-row-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}
.jev-onboarding{border-left:3px solid var(--j-brand);}.jev-onboarding-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;list-style:none;padding:0;margin:0;}.jev-onboarding-steps>li{display:flex;gap:10px;align-items:flex-start;}.jev-step-number{width:22px;height:22px;display:grid;place-items:center;border-radius:50%;background:var(--j-soft);color:var(--j-brand);font-size:11px;flex:none;}.jev-step-copy{flex:1;font-size:12px;}.jev-step-copy p{margin:4px 0 8px;}
.jev-calibration-layout{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:18px;align-items:start;}.jev-calibration-intro{display:flex;flex-direction:column;gap:15px;}.jev-calibration-intro>svg{color:var(--j-business);}.jev-advice{border:1px solid var(--j-line);border-left:3px solid var(--j-brand);border-radius:7px;background:var(--j-surface);padding:16px;display:flex;flex-direction:column;gap:10px;}
.jev-advice-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;}.jev-param{font-family:var(--ds-font-family-code,Consolas,monospace);font-size:12px;overflow-wrap:anywhere;}.jev-delta{font-variant-numeric:tabular-nums;font-size:18px;font-weight:600;color:var(--j-brand);}.jev-delta>i{font-style:normal;color:var(--j-muted);font-weight:400;padding:0 6px;}.jev-delta>del{font-size:13px;color:var(--j-muted);font-weight:400;}
.jev-advice-list{display:flex;flex-direction:column;gap:13px;}.jev-setting-status{display:flex;align-items:center;gap:8px;font-size:12px;}.jev-setting-status .jev-dot{color:var(--j-ok);}.jev-capability{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--j-line);}.jev-capability:last-child{border:0;}.jev-capability b{font-size:12px;font-weight:500;}.jev-settings-wide{grid-column:1/-1;}.jev-setting-icon{width:30px;height:30px;display:grid;place-items:center;border-radius:7px;background:color-mix(in srgb,var(--j-brand) 9%,transparent);color:var(--j-brand);}
@container jev (min-width:1200px){.jev-head{padding-inline:38px;}.jev-runbar,.jev-tabs{padding-inline:38px;}.jev-tab-body{padding-inline:38px;}}
@container jev (max-width:1000px){.jev-tag-grid{grid-template-columns:repeat(2,minmax(0,1fr));}.jev-thead,.jev-row{grid-template-columns:92px 76px minmax(80px,1fr) 92px 63px minmax(110px,1fr) 12px;gap:9px;}.jev-col-mode{display:none;}.jev-calibration-layout{grid-template-columns:minmax(0,1fr) 230px;}.jev-kpi{padding-inline:12px;}.jev-kpi b{font-size:25px;}}
@container jev (max-width:780px){.jev-head{padding:17px 20px;}.jev-runbar,.jev-tabs{padding-inline:20px;}.jev-tab-body{padding:20px;}.jev-feedback{margin-inline:20px;}.jev-overview-main{grid-template-columns:1fr;}.jev-metrics{gap:8px;}.jev-kpi small{display:none;}.jev-grid{grid-template-columns:1fr;}.jev-calibration-layout{grid-template-columns:1fr;}.jev-calibration-intro{order:2;}.jev-onboarding-steps{grid-template-columns:1fr;gap:12px;}.jev-onboarding-steps>li{align-items:center;}.jev-step-copy p{margin-block:0 5px;}.jev-live{display:none;}.jev-col-detail{display:none;}.jev-thead,.jev-row{grid-template-columns:90px 80px minmax(90px,1fr) 100px 65px 12px;}.jev-runbar{gap:10px 16px;}.jev-runbar>.jev-run-model{display:none;}}
@container jev (max-width:560px){.jev-head{padding:16px;gap:9px;}.jev-logo{width:34px;height:34px;border-radius:9px;}.jev-title{font-size:17px;}.jev-sub{font-size:10px;}.jev-head-actions{gap:3px;}.jev-head-actions .jev-btn{padding-inline:8px;font-size:11px;}.jev-head-actions .jev-btn svg{display:none;}.jev-title-row{gap:5px;}.jev-status{font-size:10px;}.jev-runbar{padding:8px 16px;font-size:11px;}.jev-runbar>span small{display:none;}.jev-tabs{padding-inline:16px;gap:18px;}.jev-tab{font-size:12px;gap:5px;}.jev-tab>svg{display:none;}.jev-tab-body{padding:18px 14px;}.jev-page{gap:16px;}.jev-metrics{grid-template-columns:repeat(3,minmax(0,1fr));}.jev-kpi:first-child{grid-column:span 2;}.jev-kpi{padding:12px;}.jev-kpi b{font-size:25px;margin:6px 0 0;}.jev-kpi-label{font-size:11px;}.jev-tag-grid{grid-template-columns:1fr;}.jev-card{padding:15px;}.jev-section-head h3{font-size:16px;}.jev-chart-bars,.jev-chart-ticks{gap:5px;}.jev-thead{display:none;}.jev-col-tag,.jev-col-lat{display:none;}.jev-row{grid-template-columns:68px minmax(50px,1fr) 94px 10px;gap:6px;padding:12px 10px;}.jev-mini-button{grid-template-columns:64px minmax(50px,1fr) 96px 10px;gap:7px;font-size:11px;}.jev-mini-button>.jev-detail{display:none;}.jev-detail-grid,.jev-evidence{grid-template-columns:repeat(2,minmax(0,1fr));}.jev-pagination{position:static;}.jev-pagination-nav .jev-btn{padding:4px 9px;}.jev-scope{white-space:normal;}.jev-provider{gap:5px;}.jev-provider>button{padding:10px 8px;}.jev-provider span{font-size:10px;}.jev-provider>button[data-on="1"]::after{right:4px;top:2px;}.jev-impact-values b{font-size:23px;}}
@media (prefers-reduced-motion:reduce){.jev-root *{transition:none!important;scroll-behavior:auto!important;}}
`
