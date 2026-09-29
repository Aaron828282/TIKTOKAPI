// 可见窗口实测：用 gs-13 的持久 profile，走与执行器完全相同的 ask_proxy 路线
// 生一张图，把 SSE 关键事件全部打到日志，供用户在 noVNC 里同步核验。
// 跑完后浏览器**保持打开 40 分钟**，用户可自己在窗口里操作验证。
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');

const PROFILE = '/opt/rhnode/data/genspark-profiles/gs-13';
const LOG = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900', '--window-position=0,0'],
    viewport: { width: 1440, height: 860 },
    timeout: 60000,
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.genspark.ai', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  // 1. 会话身份
  const user = await page.evaluate(async () => {
    const r = await fetch('/api/user', { credentials: 'include', headers: { accept: 'application/json' } });
    const t = await r.text();
    try {
      const c = (JSON.parse(t).data || {}).cogen || {};
      return { http: r.status, email: c.email || '', plan: c.plan || (c.personal_membership_ext || {}).status || '' };
    } catch { return { http: r.status, email: '', plan: '', head: t.slice(0, 120) }; }
  }).catch((e) => ({ err: e.message }));
  LOG(`账号身份: ${JSON.stringify(user)}`);

  // 2. 建项目（与执行器 ensureProject / PAGE_CREATE_PROJECT 完全同款）
  const pid = await page.evaluate(async () => {
    const r = await fetch('/api/project/create', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ article: '# image' }),
    });
    const t = await r.text();
    try { return (JSON.parse(t).data || {}).id || ''; } catch { return 'RAW:' + t.slice(0, 200); }
  }).catch((e) => { LOG('建项目失败: ' + e.message); return ''; });
  LOG(`project_id: ${pid}`);
  if (!pid) process.exit(1);

  // 3. 与执行器 generate() 完全相同的 body（quality auto 免费档）
  const mid = require('crypto').randomUUID();
  const body = {
    model_params: {
      type: 'image', model: 'gpt-image-2',
      aspect_ratio: '1:1',
      auto_prompt: false, style: 'auto',
      image_size: '1k',
      quality: 'auto',
      background_mode: true, camera_control: null, generation_count: 1,
    },
    writingContent: null, sas_ask_origin: 'typed', type: 'image_generation_agent',
    project_id: pid,
    messages: [{
      role: 'user', id: mid, content: '一只橘猫坐在窗台上看雨', pending: true,
      sendStatus: 'sending', _deepDiveStateNegContent: '一只橘猫坐在窗台上看雨', thinking: false,
    }],
    user_s_input: '一只橘猫坐在窗台上看雨', client_message_id: mid,
    is_private: true, push_token: '', last_seen_event_index: -1,
    chat_session_id: require('crypto').randomUUID(),
  };
  LOG('提交生图（ask_proxy · image_generation_agent · quality=auto · 免费路线）…');

  // 4. 页内流式消费 SSE，记录所有 field_name + 额度信号
  const out = await page.evaluate(async ({ body }) => {
    const res = await fetch('/api/agent/ask_proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: '*/*' },
      body: JSON.stringify(body), credentials: 'include',
    });
    const text = await res.text();
    const events = [];
    let limitMsg = '';
    let resultCount = 0;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      if (ev && ev.field_name) {
        if (ev.field_name === 'image_generation_agent.results') {
          const v = ev.field_value;
          if (Array.isArray(v)) resultCount += v.length;
          events.push(ev.field_name);
        } else if (ev.field_name === 'session_state.session_limit_message') {
          limitMsg = String((ev.field_value || {}).value ?? ev.field_value ?? '');
          events.push('SESSION_LIMIT_MESSAGE <<<');
        } else if (/error|fail|limit|quota/i.test(ev.field_name)) {
          events.push(ev.field_name + ' = ' + JSON.stringify(ev.field_value).slice(0, 200));
        }
      }
    }
    const urls = [];
    try {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev && ev.field_name === 'image_generation_agent.results' && Array.isArray(ev.field_value)) {
          for (const r of ev.field_value) {
            if (r && r.image_urls_nowatermark && r.image_urls_nowatermark[0]) urls.push(r.image_urls_nowatermark[0]);
            else if (r && r.image_urls && r.image_urls[0]) urls.push(r.image_urls[0]);
          }
        }
      }
    } catch { /* 忽略 */ }
    return { http: res.status, eventCount: events.length, resultCount, limitMsg, urls, otherEvents: [...new Set(events)].slice(0, 20) };
  }, { body }).catch((e) => ({ err: e.message }));

  LOG(`结果: ${JSON.stringify(out, null, 1)}`);
  if (out && out.limitMsg) LOG(`🔴 上游额度信号: ${out.limitMsg}`);
  if (out && out.urls && out.urls.length) LOG(`✅ 免费路线出图成功: ${out.urls[0].slice(0, 120)}`);

  // 5. 把主站页面导航到这个项目，用户能在 noVNC 里直接看到生图结果/额度提示
  await page.goto(`https://www.genspark.ai/agents?id=${pid}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch(() => {});
  LOG('浏览器保持打开 40 分钟（noVNC 可见），你可以直接在窗口里手动操作核验。');

  await new Promise((resolve) => setTimeout(resolve, 40 * 60 * 1000)); // 保持 40 分钟
  await ctx.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
