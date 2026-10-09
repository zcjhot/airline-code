// test-loader.js —— 验证 gzip-loader.js 能正确解压 .gz.js 文件
// 用法: node tools/test-loader.js js/airports_filtered.js
'use strict';
global.window = global;
const fs = require('fs');
const path = require('path');
const G = require(path.join(__dirname, '..', 'js', 'gzip-loader.js'));

const gzFile = process.argv[2] || path.join(__dirname, '..', 'js', 'airports_filtered.js.gz.js');
const origFile = gzFile.replace(/\.gz\.js$/, '');

eval(fs.readFileSync(gzFile, 'utf8'));           // 得到 window.__GZ_B64__
const b64 = window.__GZ_B64__;

const t0 = Date.now();
const out = G.ungzipBase64(b64);
const ms = Date.now() - t0;

const orig = fs.readFileSync(origFile, 'utf8').replace(/^\uFEFF/, '');
console.log('解压字符数 :', out.length);
console.log('原始字符数 :', orig.length);
console.log('解压耗时   :', ms, 'ms');
console.log('内容一致   :', out === orig ? 'PASS ✓' : 'FAIL ✗');
if (out !== orig) process.exit(1);
