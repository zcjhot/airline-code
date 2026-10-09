/**
 * D1 数据库连接测试（前端部分）
 * 当用户键入满三个字符（说明用户在查询）时，
 * 将键入的值上报到 /api/log-search，
 * 由 Cloudflare Pages Function 写入 D1 mydata 数据库的 search_log 表。
 *
 * 注意：softkeys 插件用 jQuery .trigger('input') 更新输入框，
 * 原生 addEventListener 监听不到，必须用 jQuery 绑定事件。
 */
(function () {
    var API_URL = '/api/log-search';
    var $input = $('input[name="code"]');
    if (!$input.length) return;

    var lastLogged = ''; // 避免同一个三字码重复上报

    function logToD1(code) {
        console.log('[D1] 开始上报:', code);
        fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: code })
        })
        .then(function (res) {
            // 先读文本再解析，避免 404/500 返回 HTML 时 json() 抛错看不到状态码
            return res.text().then(function (text) {
                console.log('[D1] 响应 HTTP', res.status, text);
                try {
                    return JSON.parse(text);
                } catch (e) {
                    throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 200));
                }
            });
        })
        .then(function (data) {
            if (data.success) {
                console.log('[D1] 写入成功:', code);
            } else {
                console.error('[D1] 写入失败:', data.error);
            }
        })
        .catch(function (err) {
            console.error('[D1] 连接失败:', err.message || err);
        });
    }

    $input.on('input', function () {
        var value = $(this).val().trim().toUpperCase();
        if (value.length === 3 && value !== lastLogged) {
            lastLogged = value;
            logToD1(value);
        }
        // 删除字符后允许重新记录
        if (value.length < 3) {
            lastLogged = '';
        }
    });
})();
