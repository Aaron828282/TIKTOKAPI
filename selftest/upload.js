'use strict';
/**
 * 参考图上传自测 —— 在本机用**真实 cookie**跑一遍 `uploadImage` 的五步链路。
 *
 * 为什么需要它：R2V 只认 TikTok 自家图床的素材，任何外部图都得先走
 * getSts → ApplyImageUpload → PUT → CommitImageUpload → 拼 CDN。
 * 线上报「CommitImageUpload 失败（imagex 604033 Upload internal error）」时，
 * 这里能把**每一步的中间结果**打出来，判断是偶发、是图不对、还是环境差异。
 *
 * 用法（在本目录下）：
 *   node selftest/upload.js --cookie /path/cookie.txt --proxy http://127.0.0.1:7890 \
 *        --image-url https://… [--image-url https://…] [--dump]
 *
 * 只读 + 上传素材，**不提交生成任务、不消耗积分**。
 *
 * ⚠️ 这里下载源图**刻意用 curl 落盘**而不是 `curlFetch`：后者把响应当 utf8
 *    文本读，二进制会损坏；而 `upload.*` 的业务请求是 JSON，才适合 `curlFetch`。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { cfg } = require('../lib/config');
const { normalizeSession } = require('../lib/session');
const upload = require('../lib/upload');
const { curlFetch } = require('./proxyfetch');

function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === '--' + name && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1]);
  });
  return out;
}
function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const has = (n) => process.argv.includes('--' + n);

/** 二进制安全下载：让 curl 直接落盘，返回 {status, bytes}。 */
function download(url, proxy, out) {
  const args = ['-sS', '-L', '-m', '60', '-o', out, '-w', '%{http_code}'];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const p = spawnSync('curl.exe', args, { maxBuffer: 4 * 1024 * 1024 });
  const status = Number((p.stdout || '').toString().trim()) || 0;
  const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
  return { status, bytes };
}

async function main() {
  const cookieFile = arg('cookie');
  const proxy = arg('proxy', process.env.HTTPS_PROXY || '');
  const urls = argAll('image-url');
  if (!cookieFile || !urls.length) {
    console.error('用法：node selftest/upload.js --cookie <file> [--proxy http://…] --image-url <url> [--image-url <url>]');
    process.exit(2);
  }

  const cookie = fs.readFileSync(path.resolve(cookieFile), 'utf8').trim();
  const session = normalizeSession({
    cookie,
    x_csrftoken: (cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || '',
    x_fp_id: arg('fp', '68320d0b1fb0a537e8715e73d8c4c053'),
    device_id: arg('did', '7671503800712054289'),
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  });
  const fetchImpl = curlFetch(proxy);
  const opts = { fetchImpl };
  const tmp = path.join(os.tmpdir(), 'rh-upload-selftest.bin');

  console.log(`目标 ${cfg.origin}${proxy ? `（经代理 ${proxy}）` : '（直连）'}`);
  console.log(`ServiceId=${cfg.serviceId}  CdnHost=${cfg.cdnHost}`);
  console.log('');

  let pass = 0, fail = 0;
  for (let n = 0; n < urls.length; n += 1) {
    const url = urls[n];
    console.log(`───── 第 ${n + 1}/${urls.length} 张 ─────`);
    console.log(`源图 ${url}`);

    // 1) 下载源图
    let data;
    try {
      const dl = download(url, proxy, tmp);
      if (dl.status !== 200) throw new Error(`HTTP ${dl.status}`);
      data = fs.readFileSync(tmp);
      console.log(`  ✓ 下载 ${data.length} 字节`);
    } catch (e) {
      console.log(`  ✗ 下载失败：${e.message}`);
      fail += 1;
      continue;
    }

    // 2) 取 STS
    let sts;
    try {
      sts = await upload.getSts(session, cfg, (m) => console.log('  ' + m.trim()), opts);
      console.log(`  ✓ STS 有效至 ${sts.ExpiredTime}（CurrentTime=${sts.CurrentTime}）`);
    } catch (e) {
      console.log(`  ✗ 取 STS 失败：${e.message}`);
      fail += 1;
      continue;
    }

    // 3) ApplyImageUpload
    let up;
    try {
      up = await upload.applyUpload(session, cfg, sts, data.length, (m) => console.log('  ' + m.trim()), opts);
      console.log(`  ✓ Apply OK  StoreUri=${up.storeUri}`);
      console.log(`      UploadHost=${up.uploadHost}  SessionKey=${String(up.sessionKey).slice(0, 30)}…`);
      if (has('dump')) {
        const a = (up.raw.Result || {}).UploadAddress || {};
        console.log('      Result 顶层键   : ' + Object.keys(up.raw.Result || {}).join(', '));
        console.log('      UploadAddress 键: ' + Object.keys(a).join(', '));
        console.log('      SessionKey 位置 : Result=' + JSON.stringify((up.raw.Result || {}).SessionKey)
          + '  UploadAddress=' + JSON.stringify(String(a.SessionKey || '').slice(0, 30) + '…'));
        console.log('      UploadAddress 结构：' + JSON.stringify({
          UploadHosts: a.UploadHosts,
          StoreInfos: (a.StoreInfos || []).map((s) => ({
            StoreUri: s.StoreUri, UploadHost: s.UploadHost,
            AuthLen: String(s.Auth || '').length,
          })),
          InnerUploadAddress: a.InnerUploadAddress,
        }, null, 2).split('\n').join('\n      '));
      }
    } catch (e) {
      console.log(`  ✗ Apply 失败：${e.message}`);
      fail += 1;
      continue;
    }

    // 4) PUT 字节
    try {
      await upload.putBytes(cfg, up, data, (m) => console.log('  ' + m.trim()), opts);
      console.log('  ✓ PUT 成功（code=2000）');
    } catch (e) {
      console.log(`  ✗ PUT 失败：${e.message}`);
      fail += 1;
      continue;
    }

    // 5) Commit —— 线上就是死在这一步
    try {
      const c = await upload.commitUpload(session, cfg, sts, up.sessionKey, (m) => console.log('  ' + m.trim()), opts);
      console.log(`  ✓ Commit 成功  Uri=${c.uri}`);
      console.log(`  → CDN ${upload.cdnUrl(cfg, up.storeUri).slice(0, 110)}`);
      pass += 1;
    } catch (e) {
      console.log(`  ✗ Commit 失败：${e.message}`);
      const m = /"Error":(\{.*?\})/.exec(e.message);
      if (m) console.log(`     Error 明细：${m[1]}`);
      fail += 1;
    }
    console.log('');
  }

  console.log(`===== ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('自测自身出错：', e && e.stack || e); process.exit(3); });
