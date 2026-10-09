/*!
 * GzipLoader v1.0.0 —— 前端 gzip 解压/执行工具（纯 JS 实现，零依赖，可复用）
 *
 * 配合 gzip 压缩工具生成的 "*.gz.js" 文件使用（内嵌 base64 的 gzip 数据）。
 * 优点：走普通 <script> 加载，file:// 与 http(s) 均可用，无需任何服务器配置。
 *
 * 用法（同步，最简单）：
 *   <script src="js/gzip-loader.js"></script>
 *   <script src="js/xxx.js.gz.js"></script>          // 生成物，定义 window.__GZ_B64__
 *   <script>GzipLoader.exec(window.__GZ_B64__);</script>  // 解压并按全局作用域执行原 js
 *
 * 用法（异步，现代浏览器走原生 DecompressionStream，更快）：
 *   GzipLoader.execAsync(window.__GZ_B64__).then(...).catch(...)
 *
 * API：
 *   GzipLoader.ungzipBytes(u8)          Uint8Array(gzip) -> Uint8Array(原始字节)
 *   GzipLoader.ungzipBase64(b64Str)     base64 字符串   -> 原始文本字符串
 *   GzipLoader.exec(b64Str)             解压 + 全局作用域执行，等效于 <script src="原js">
 *   GzipLoader.execAsync(b64Str)        同上，返回 Promise
 *   GzipLoader.execCode(codeStr)        将任意 js 代码以全局作用域执行
 *
 * 实现说明：内部为 RFC1951(DEFLATE)/RFC1952(GZIP) 的纯 JS 解码器，
 * 含 CRC32 与长度校验；兼容 ES5 浏览器（无 DecompressionStream 也能用）。
 */
(function (global) {
    'use strict';

    /* ---------------- base64 -> Uint8Array ---------------- */
    function base64ToBytes(b64) {
        var s = String(b64).replace(/\s+/g, ''), bin;
        if (typeof atob === 'function') {
            bin = atob(s);
        } else if (typeof Buffer !== 'undefined') { /* Node 环境 */
            bin = Buffer.from(s, 'base64').toString('binary');
        } else {
            throw new Error('GzipLoader: 当前环境不支持 atob');
        }
        var len = bin.length, bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    /* ---------------- CRC32 ---------------- */
    var CRC_TABLE = (function () {
        var t = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c;
        }
        return t;
    })();

    function crc32(bytes, len) {
        var c = 0xFFFFFFFF;
        for (var i = 0; i < len; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    /* ---------------- UTF-8 字节 -> 字符串 ---------------- */
    function utf8ToString(bytes, len) {
        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder('utf-8').decode(bytes.subarray(0, len));
        }
        /* 极老浏览器的手写解码 */
        var out = '', i = 0, c, c2, c3, c4, cp;
        while (i < len) {
            c = bytes[i++];
            if (c < 128) out += String.fromCharCode(c);
            else if (c < 224) { c2 = bytes[i++]; out += String.fromCharCode(((c & 31) << 6) | (c2 & 63)); }
            else if (c < 240) { c2 = bytes[i++]; c3 = bytes[i++]; out += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63)); }
            else {
                c2 = bytes[i++]; c3 = bytes[i++]; c4 = bytes[i++];
                cp = ((c & 7) << 18) | ((c2 & 63) << 12) | ((c3 & 63) << 6) | (c4 & 63);
                cp -= 0x10000;
                out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
            }
        }
        return out;
    }

    /* ---------------- DEFLATE 常量表 (RFC1951) ---------------- */
    var L_BASE  = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    var L_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    var D_BASE  = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    var D_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    var CLEN_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

    /* 由码长数组构建规范哈夫曼解码表（puff 算法） */
    function buildHuffman(lengths, off, n) {
        var count = new Uint16Array(16), symbol = new Uint16Array(n), i, left = 1;
        for (i = 0; i < n; i++) count[lengths[off + i]]++;
        count[0] = 0;
        for (i = 1; i <= 15; i++) {          /* 过订阅(超码空间)则非法 */
            left <<= 1;
            left -= count[i];
            if (left < 0) return null;       /* 欠订阅(不完整)是允许的 */
        }
        var offs = new Uint16Array(16);
        for (i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
        for (i = 0; i < n; i++) { var l = lengths[off + i]; if (l !== 0) symbol[offs[l]++] = i; }
        return { count: count, symbol: symbol };
    }

    /* ---------------- inflate：解压 DEFLATE 数据流 ----------------
     * data: 输入 Uint8Array；startPos: DEFLATE 起始偏移；expectedSize: 预期解压大小（来自 gzip 尾部 ISIZE）
     * 返回 { bytes: Uint8Array, length: 实际输出字节数 } */
    function inflate(data, startPos, expectedSize) {
        var inLen = data.length;
        var cap = (expectedSize && expectedSize < 0x40000000) ? expectedSize : 65536;
        var out = new Uint8Array(cap), outPos = 0, inPos = startPos;
        var bitbuf = 0, bitcnt = 0;
        var litH = null, distH = null, fixedLit = null, fixedDist = null;
        var lengths = new Uint8Array(320);
        var i, sym, rep, len, dist, from;

        function ensure(n) {
            if (n <= out.length) return;
            var newCap = out.length * 2;
            while (newCap < n) newCap *= 2;
            var nb = new Uint8Array(newCap);
            nb.set(out);
            out = nb;
        }

        function bits(n) {                   /* 读取 n 个比特（低位在前） */
            while (bitcnt < n) {
                if (inPos >= inLen) throw new Error('inflate: 输入数据意外结束');
                bitbuf |= data[inPos++] << bitcnt;
                bitcnt += 8;
            }
            var v = bitbuf & ((1 << n) - 1);
            bitbuf >>>= n; bitcnt -= n;
            return v;
        }

        function decodeSym(h) {              /* 逐位解码一个哈夫曼符号 */
            var code = 0, first = 0, index = 0, count;
            for (var l = 1; l <= 15; l++) {
                if (bitcnt === 0) {
                    if (inPos >= inLen) throw new Error('inflate: 输入数据意外结束');
                    bitbuf = data[inPos++];
                    bitcnt = 8;
                }
                code |= bitbuf & 1;
                bitbuf >>>= 1; bitcnt--;
                count = h.count[l];
                if (code - first < count) return h.symbol[index + (code - first)];
                index += count;
                first = (first + count) << 1;
                code <<= 1;
            }
            throw new Error('inflate: 无效的哈夫曼编码');
        }

        function decodeBlock() {             /* 解码一个压缩数据块直到块结束符(256) */
            for (;;) {
                sym = decodeSym(litH);
                if (sym < 256) {
                    if (outPos >= out.length) ensure(outPos + 1);
                    out[outPos++] = sym;
                } else if (sym === 256) {
                    return;
                } else {
                    sym -= 257;
                    if (sym >= 29) throw new Error('inflate: 无效长度码');
                    len = L_BASE[sym] + (L_EXTRA[sym] ? bits(L_EXTRA[sym]) : 0);
                    sym = decodeSym(distH);
                    if (sym >= 30) throw new Error('inflate: 无效距离码');
                    dist = D_BASE[sym] + (D_EXTRA[sym] ? bits(D_EXTRA[sym]) : 0);
                    if (dist > outPos) throw new Error('inflate: 距离超出已输出范围');
                    if (outPos + len > out.length) ensure(outPos + len);
                    from = outPos - dist;
                    if (dist >= len) {
                        out.set(out.subarray(from, from + len), outPos);   /* 无重叠，快拷贝 */
                    } else {
                        for (i = 0; i < len; i++) out[outPos + i] = out[from + i]; /* LZ77 重叠复制 */
                    }
                    outPos += len;
                }
            }
        }

        var last = 0;
        while (!last) {
            last = bits(1);
            var type = bits(2);
            if (type === 0) {                /* 00: 非压缩存储块 */
                bitbuf = 0; bitcnt = 0;      /* 丢弃未消费比特，按字节对齐 */
                if (inPos + 4 > inLen) throw new Error('inflate: 存储块头不完整');
                len = data[inPos] | (data[inPos + 1] << 8);
                var nlen = data[inPos + 2] | (data[inPos + 3] << 8);
                if ((len ^ 0xFFFF) !== nlen) throw new Error('inflate: 存储块长度校验失败');
                inPos += 4;
                if (inPos + len > inLen) throw new Error('inflate: 存储块数据不完整');
                ensure(outPos + len);
                out.set(data.subarray(inPos, inPos + len), outPos);
                inPos += len; outPos += len;
            } else if (type === 1 || type === 2) {
                if (type === 1) {            /* 01: 固定哈夫曼表 */
                    if (!fixedLit) {
                        var fl = new Uint8Array(288), fd = new Uint8Array(30);
                        for (i = 0; i < 144; i++) fl[i] = 8;
                        for (; i < 256; i++) fl[i] = 9;
                        for (; i < 280; i++) fl[i] = 7;
                        for (; i < 288; i++) fl[i] = 8;
                        for (i = 0; i < 30; i++) fd[i] = 5;
                        fixedLit = buildHuffman(fl, 0, 288);
                        fixedDist = buildHuffman(fd, 0, 30);
                    }
                    litH = fixedLit; distH = fixedDist;
                } else {                     /* 10: 动态哈夫曼表 */
                    var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
                    if (hlit + hdist > 320) throw new Error('inflate: 码长数超限');
                    var clen = new Uint8Array(19);
                    for (i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = bits(3);
                    var clH = buildHuffman(clen, 0, 19);
                    if (!clH) throw new Error('inflate: 码长表无效');
                    var total = hlit + hdist, idx = 0;
                    while (idx < total) {
                        sym = decodeSym(clH);
                        if (sym < 16) {
                            lengths[idx++] = sym;
                        } else if (sym === 16) {
                            if (idx === 0) throw new Error('inflate: 首位码长不可重复');
                            var prev = lengths[idx - 1];
                            rep = 3 + bits(2);
                            if (idx + rep > total) throw new Error('inflate: 码长重复越界');
                            while (rep--) lengths[idx++] = prev;
                        } else if (sym === 17) {
                            rep = 3 + bits(3);
                            if (idx + rep > total) throw new Error('inflate: 码长置零越界');
                            while (rep--) lengths[idx++] = 0;
                        } else {             /* 18 */
                            rep = 11 + bits(7);
                            if (idx + rep > total) throw new Error('inflate: 码长置零越界');
                            while (rep--) lengths[idx++] = 0;
                        }
                    }
                    litH = buildHuffman(lengths, 0, hlit);
                    distH = buildHuffman(lengths, hlit, hdist);
                    if (!litH || !distH) throw new Error('inflate: 动态哈夫曼表无效');
                }
                decodeBlock();
            } else {
                throw new Error('inflate: 无效的块类型(11)');
            }
        }
        return { bytes: out, length: outPos };
    }

    /* ---------------- gzip 容器解析 (RFC1952) ---------------- */
    function ungzipBytes(data) {
        if (!data || data.length < 20) throw new Error('gzip: 数据无效或太短');
        if (data[0] !== 0x1F || data[1] !== 0x8B) throw new Error('gzip: 非法文件头（魔数不匹配）');
        if (data[2] !== 8) throw new Error('gzip: 仅支持 deflate 压缩方法');
        var flg = data[3], pos = 10;
        if (flg & 4) {                       /* FEXTRA */
            if (pos + 2 > data.length) throw new Error('gzip: 文件头异常');
            pos += 2 + (data[pos] | (data[pos + 1] << 8));
        }
        if (flg & 8) { while (pos < data.length && data[pos] !== 0) pos++; pos++; } /* FNAME */
        if (flg & 16) { while (pos < data.length && data[pos] !== 0) pos++; pos++; } /* FCOMMENT */
        if (flg & 2) pos += 2;               /* FHCRC */
        if (pos > data.length - 8) throw new Error('gzip: 文件头异常');

        var res = inflate(data, pos, readLE32(data, data.length - 4));
        var bytes = res.bytes, n = res.length;
        var crc = readLE32(data, data.length - 8);
        if (crc32(bytes, n) !== crc) throw new Error('gzip: CRC32 校验失败（数据损坏）');
        if (n >>> 0 !== readLE32(data, data.length - 4)) throw new Error('gzip: 长度校验失败');
        return n === bytes.length ? bytes : bytes.subarray(0, n);
    }

    function readLE32(b, p) {
        return ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0);
    }

    /* ---------------- 对外 API ---------------- */
    var GzipLoader = {
        version: '1.0.0',

        ungzipBytes: ungzipBytes,

        ungzipBase64: function (b64) {
            var bytes = ungzipBytes(base64ToBytes(b64));
            return utf8ToString(bytes, bytes.length);
        },

        /* 将 js 源码以全局作用域执行（等效 <script src>），顶层 var/const 语义不变 */
        execCode: function (code) {
            if (typeof document === 'undefined') throw new Error('GzipLoader: execCode 仅支持浏览器');
            var script = document.createElement('script');
            script.text = code;              /* 属性赋值不走 HTML 解析，安全 */
            (document.head || document.documentElement).appendChild(script);
            return code.length;
        },

        /* 解压 + 执行（同步） */
        exec: function (b64) {
            var bytes = ungzipBytes(base64ToBytes(b64));
            var code = utf8ToString(bytes, bytes.length);
            return GzipLoader.execCode(code);
        },

        /* 解压 + 执行（异步）：优先用浏览器原生 DecompressionStream，不支持则同步兜底 */
        execAsync: function (b64) {
            try {
                if (typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined') {
                    return Promise.resolve(GzipLoader.exec(b64));
                }
                var bytes = base64ToBytes(b64);
                var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
                return new Response(stream).text().then(function (code) {
                    return GzipLoader.execCode(code);
                });
            } catch (e) {
                return Promise.reject(e);
            }
        }
    };

    global.GzipLoader = GzipLoader;
    if (typeof module !== 'undefined' && module.exports) module.exports = GzipLoader; /* Node 复用/测试 */

})(typeof window !== 'undefined' ? window : this);
