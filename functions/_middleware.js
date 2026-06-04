/**
 * Cloudflare Pages Functions —— 处理所有 /api/* 路由 + 全站安全响应头
 *
 * 绑定（部署时在 Pages 项目设置里配置）：
 *   KV  -> SITE_KV          （作品列表 / 设置 / 密码哈希 / 登录限流计数）
 *   R2  -> MEDIA_BUCKET     （视频和图片）
 *   ENV -> R2_PUBLIC_URL    （R2 公开访问域名，例如 https://pub-xxx.r2.dev 或自定义域）
 *   ENV -> JWT_SECRET       （随机字符串，签 token —— 建议设为「机密(Secret)」类型）
 *   ENV -> INITIAL_PASSWORD （首次登录引导密码 —— 建议设为「机密」；初始化完成后即可删除）
 */

// ============ 可调参数 ============
const TOKEN_TTL_MS = 2 * 24 * 60 * 60 * 1000;   // token 有效期：2 天
const PBKDF2_ITERATIONS = 100000;               // 口令哈希迭代次数（如登录偶发超时可调低到 50000）
const MIN_PASSWORD_LEN = 12;                    // 改密码最小长度
const LOGIN_MAX_ATTEMPTS = 8;                   // 同一 IP 在窗口内最多失败次数
const LOGIN_WINDOW_SEC = 900;                   // 限流窗口：15 分钟

// ============ 基础工具 ============
const enc = new TextEncoder();

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}

function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

// 常量时间比较，避免计时侧信道
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
}

// 缺失或仍是默认值 → 返回 null（不再回退到公开默认串）
function getSecret(env) {
    const s = env.JWT_SECRET;
    if (!s || s === 'change-me') return null;
    return s;
}

// ============ token（HMAC-SHA256：body.sig） ============
async function signToken(secret, payload) {
    const body = btoa(JSON.stringify(payload));
    const key = await crypto.subtle.importKey('raw', enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    return body + '.' + b64(new Uint8Array(sig));
}

async function verifyToken(secret, token) {
    if (!token || !token.includes('.')) return null;
    const [body, sigB64] = token.split('.');
    try {
        const key = await crypto.subtle.importKey('raw', enc.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        const ok = await crypto.subtle.verify('HMAC', key, unb64(sigB64), enc.encode(body));
        if (!ok) return null;
        const payload = JSON.parse(atob(body));
        if (payload.exp && payload.exp < Date.now()) return null;
        return payload;
    } catch {
        return null;
    }
}

async function checkAuth(request, env) {
    const secret = getSecret(env);
    if (!secret) return null;
    const auth = request.headers.get('Authorization') || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return await verifyToken(secret, tok);
}

// ============ 口令哈希（PBKDF2-SHA256 + 随机盐） ============
// 存储格式：pbkdf2$<iter>$<salt_b64>$<hash_b64>
async function pbkdf2(pwd, salt, iterations) {
    const km = await crypto.subtle.importKey('raw', enc.encode(pwd), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, km, 256);
    return new Uint8Array(bits);
}

async function makePasswordRecord(pwd) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await pbkdf2(pwd, salt, PBKDF2_ITERATIONS);
    return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

async function verifyPassword(pwd, stored) {
    if (!stored) return false;
    if (stored.startsWith('pbkdf2$')) {
        const parts = stored.split('$');
        const iter = parseInt(parts[1], 10) || PBKDF2_ITERATIONS;
        const salt = unb64(parts[2]);
        const hash = await pbkdf2(pwd, salt, iter);
        return safeEqual(b64(hash), parts[3]);
    }
    // 兼容旧格式（无盐单次 SHA-256 的 base64），校验通过后由调用方升级
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(pwd));
    return safeEqual(b64(new Uint8Array(buf)), stored);
}

// ============ 登录限流（基于 KV 按 IP 计数；出错则放行，绝不因限流把人锁死） ============
function clientIp(request) {
    return request.headers.get('CF-Connecting-IP') || '';
}
async function isRateLimited(env, ip) {
    if (!ip) return false;
    try {
        const n = parseInt(await env.SITE_KV.get(`rl:login:${ip}`) || '0', 10);
        return n >= LOGIN_MAX_ATTEMPTS;
    } catch { return false; }
}
async function bumpAttempt(env, ip) {
    if (!ip) return;
    try {
        const n = parseInt(await env.SITE_KV.get(`rl:login:${ip}`) || '0', 10);
        await env.SITE_KV.put(`rl:login:${ip}`, String(n + 1), { expirationTtl: LOGIN_WINDOW_SEC });
    } catch {}
}
async function clearAttempts(env, ip) {
    if (!ip) return;
    try { await env.SITE_KV.delete(`rl:login:${ip}`); } catch {}
}

// ============ 安全响应头 ============
function withSecurityHeaders(response, env) {
    const res = new Response(response.body, response);
    const h = res.headers;
    const ct = h.get('Content-Type') || '';
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('X-Frame-Options', 'DENY');
    h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), browsing-topics=()');
    h.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');

    if (ct.includes('text/html')) {
        let r2 = '';
        try { r2 = new URL(env.R2_PUBLIC_URL).origin; } catch {}
        const csp = [
            "default-src 'self'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "object-src 'none'",
            `img-src 'self' data: ${r2}`.trim(),
            `media-src 'self' blob: ${r2}`.trim(),
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' data: https://fonts.gstatic.com",
            `connect-src 'self' ${r2}`.trim()
        ].join('; ');
        // 先用 Report-Only（只报告、不拦截）。确认浏览器控制台无 CSP 报错后，
        // 把下面这行的 'Content-Security-Policy-Report-Only' 改成 'Content-Security-Policy' 即正式生效。
        h.set('Content-Security-Policy-Report-Only', csp);
    } else if (ct.includes('application/json')) {
        h.set('Cache-Control', 'no-store');
    }
    return res;
}

// ============ 入口 ============
export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    let response;
    if (url.pathname.startsWith('/api/')) {
        response = await handleApi(context, url);
    } else {
        response = await context.next();
    }
    return withSecurityHeaders(response, env);
}

// ============ /api/* 业务逻辑 ============
async function handleApi(context, url) {
    const { request, env } = context;
    const path = url.pathname;

    try {
        // ----- 公开读取 -----
        if (path === '/api/works' && request.method === 'GET') {
            return json((await env.SITE_KV.get('works', 'json')) || []);
        }
        if (path === '/api/settings' && request.method === 'GET') {
            return json((await env.SITE_KV.get('settings', 'json')) || {});
        }

        // ----- 登录（限流 + PBKDF2 + 旧哈希自动升级） -----
        if (path === '/api/login' && request.method === 'POST') {
            const secret = getSecret(env);
            if (!secret) return json({ error: '服务未正确配置（缺少 JWT_SECRET）' }, 500);

            const ip = clientIp(request);
            if (await isRateLimited(env, ip)) {
                return json({ error: '尝试次数过多，请 15 分钟后再试' }, 429);
            }

            const { password } = await request.json();
            if (!password) return json({ error: '缺少密码' }, 400);

            let ok = false;
            let needUpgrade = false;
            const storedHash = await env.SITE_KV.get('admin_password_hash');

            if (!storedHash) {
                // 首次：用环境变量 INITIAL_PASSWORD 引导
                const initial = env.INITIAL_PASSWORD;
                if (!initial) return json({ error: '系统未初始化（缺少 INITIAL_PASSWORD）' }, 500);
                ok = safeEqual(password, initial);
                if (ok) await env.SITE_KV.put('admin_password_hash', await makePasswordRecord(password));
            } else {
                ok = await verifyPassword(password, storedHash);
                needUpgrade = ok && !storedHash.startsWith('pbkdf2$');
            }

            if (!ok) {
                await bumpAttempt(env, ip);
                return json({ error: '密码错误' }, 401);
            }

            if (needUpgrade) {
                // 旧的无盐 SHA-256 → 升级为 PBKDF2（无感）
                await env.SITE_KV.put('admin_password_hash', await makePasswordRecord(password));
            }
            await clearAttempts(env, ip);

            const token = await signToken(secret, { role: 'admin', exp: Date.now() + TOKEN_TTL_MS });
            return json({ token });
        }

        // ----- 以下均需登录 -----
        const auth = await checkAuth(request, env);
        if (!auth) return json({ error: '未授权' }, 401);

        // 作品
        if (path === '/api/admin/works' && request.method === 'GET') {
            return json((await env.SITE_KV.get('works', 'json')) || []);
        }
        if (path === '/api/admin/works' && request.method === 'PUT') {
            const arr = await request.json();
            if (!Array.isArray(arr)) return json({ error: '数据格式错误' }, 400);
            await env.SITE_KV.put('works', JSON.stringify(arr));
            return json({ ok: true });
        }

        // 设置
        if (path === '/api/admin/settings' && request.method === 'GET') {
            return json((await env.SITE_KV.get('settings', 'json')) || {});
        }
        if (path === '/api/admin/settings' && request.method === 'PUT') {
            const obj = await request.json();
            await env.SITE_KV.put('settings', JSON.stringify(obj));
            return json({ ok: true });
        }

        // 改密码
        if (path === '/api/admin/password' && request.method === 'PUT') {
            const { password } = await request.json();
            if (!password || password.length < MIN_PASSWORD_LEN) {
                return json({ error: `密码至少 ${MIN_PASSWORD_LEN} 位` }, 400);
            }
            await env.SITE_KV.put('admin_password_hash', await makePasswordRecord(password));
            return json({ ok: true });
        }

        // 上传到 R2
        const up = path.match(/^\/api\/admin\/upload\/(.+)$/);
        if (up && request.method === 'PUT') {
            const key = decodeURIComponent(up[1]);
            if (!key || key.length > 200) return json({ error: '文件名无效' }, 400);
            const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
            await env.MEDIA_BUCKET.put(key, request.body, { httpMetadata: { contentType } });
            const base = (env.R2_PUBLIC_URL || '').replace(/\/$/, '');
            return json({ ok: true, key, url: base + '/' + encodeURIComponent(key).replace(/%2F/g, '/') });
        }

        // 列出 R2
        if (path === '/api/admin/media' && request.method === 'GET') {
            const list = await env.MEDIA_BUCKET.list({ limit: 200 });
            const base = (env.R2_PUBLIC_URL || '').replace(/\/$/, '');
            const items = list.objects.map(o => ({
                key: o.key, size: o.size, uploaded: o.uploaded,
                url: base + '/' + encodeURIComponent(o.key).replace(/%2F/g, '/')
            }));
            items.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
            return json(items);
        }

        // 删除 R2
        const del = path.match(/^\/api\/admin\/media\/(.+)$/);
        if (del && request.method === 'DELETE') {
            await env.MEDIA_BUCKET.delete(decodeURIComponent(del[1]));
            return json({ ok: true });
        }

        return json({ error: '路径不存在' }, 404);

    } catch (err) {
        console.error('API error:', err);
        return json({ error: '服务器错误' }, 500);   // 不再把内部错误细节返回给前端
    }
}
