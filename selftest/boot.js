'use strict';
/**
 * 自测入口 —— 把上游 I/O 换成假的，然后加载**真的 `index.js`**。
 *
 * 为什么用 require 缓存替换而不是改 index.js：编排逻辑（取活、心跳、取消检测、
 * 交付、回报）正是要测的东西，一行都不能为了「好测」而改。所以只把
 * `lib/tiktok.js` / `lib/upload.js` 这两个 I/O 模块的导出换掉。
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function stub(relFromRoot, fakeRel) {
  const real = require.resolve(path.join(ROOT, relFromRoot));
  const fake = require(path.join(__dirname, fakeRel));
  require.cache[real] = {
    id: real, filename: real, loaded: true, children: [], paths: [], exports: fake,
  };
}

stub(path.join('lib', 'tiktok.js'), 'fake-tiktok.js');
stub(path.join('lib', 'upload.js'), 'fake-upload.js');

require(path.join(ROOT, 'index.js'));
