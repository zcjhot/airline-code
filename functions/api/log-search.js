// Cloudflare Pages Function —— D1 数据库连接接口
// 数据库: mydata   表: search_log
// 部署前请在 Pages 项目 设置 → 绑定 → D1数据库 添加绑定:
//   变量名: testdata    数据库: mydata

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS)
    });
}

// POST /api/log-search  body: {"code":"CCA"} → 写入一条查询记录
export async function onRequestPost({ request, env }) {
    try {
        if (!env.testdata) {
            return json({ success: false, error: '未绑定 D1 数据库：请在 Pages 设置 → 绑定 中将变量名 testdata 绑定到数据库 mydata' }, 500);
        }

        const body = await request.json();
        const code = String(body.code || '').trim().toUpperCase();

        if (!/^[A-Z]{3}$/.test(code)) {
            return json({ success: false, error: 'code 必须为三个字母' }, 400);
        }

        // 首次运行自动建表
        await env.testdata.prepare(
            `CREATE TABLE IF NOT EXISTS search_log (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                code       TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            )`
        ).run();

        const result = await env.testdata.prepare(
            'INSERT INTO search_log (code) VALUES (?)'
        ).bind(code).run();

        return json({ success: true, code: code, meta: result.meta });
    } catch (err) {
        return json({ success: false, error: err.message }, 500);
    }
}

// GET /api/log-search → 返回最近 20 条记录，用于验证数据库连接
export async function onRequestGet({ env }) {
    try {
        if (!env.testdata) {
            return json({ success: false, error: '未绑定 D1 数据库：请在 Pages 设置 → 绑定 中将变量名 testdata 绑定到数据库 mydata' }, 500);
        }

        const { results } = await env.testdata.prepare(
            'SELECT * FROM search_log ORDER BY id DESC LIMIT 20'
        ).all();

        return json({ success: true, rows: results });
    } catch (err) {
        return json({ success: false, error: err.message }, 500);
    }
}

export async function onRequestOptions() {
    return new Response(null, { headers: CORS_HEADERS });
}
