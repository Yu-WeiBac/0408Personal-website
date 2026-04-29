/**
 * Cloudflare Pages Functions —— 处理所有 /api/* 路由
 *
 * 绑定（部署时在 Pages 项目设置里配置）：
 *   KV  -> SITE_KV       （存作品列表 / 设置 / 密码）
 *   R2  -> MEDIA_BUCKET  （存视频和图片）
 *   ENV -> R2_PUBLIC_URL （R2 公开访问的域名，例如 https://videos.04080606.xyz）
 *   ENV -> JWT_SECRET    （随机字符串，用于签 token）
 */

// ============ 工具函数 ============

const enc = new TextEncoder();
const dec = new TextDecoder();

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}

function text(s, status = 200) {
    return new Response(s, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// 简单的 HMAC-SHA256 token：payload.sig
async function signToken(secret, payload) {
    const body = btoa(JSON.stringify(payload));
    const key = await crypto.subtle.importKey('raw', enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return body + '.' + sigB64;
}

async function verifyToken(secret, token) {
    if (!token || !token.includes('.')) return null;
    const [body, sigB64] = token.split('.');
    try {
        const key = await crypto.subtle.importKey('raw', enc.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        const sig = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
        const ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(body));
        if (!ok) return null;
        const payload = JSON.parse(atob(body));
        if (payload.exp && payload.exp < Date.now()) return null;
        return payload;
    } catch {
        return null;
    }
}

async function hashPassword(pwd) {
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(pwd));
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function checkAuth(request, env) {
    const auth = request.headers.get('Authorization') || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return await verifyToken(env.JWT_SECRET || 'change-me', tok);
}

// ============ 主路由 ============

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;

    // 仅处理 /api/* 路径
    if (!path.startsWith('/api/')) {
        return context.next();
    }

    try {
        // ----- 公开 API（前台读取） -----
        if (path === '/api/works' && request.method === 'GET') {
            const data = await env.SITE_KV.get('works', 'json');
            return json(data || []);
        }
        if (path === '/api/settings' && request.method === 'GET') {
            const data = await env.SITE_KV.get('settings', 'json');
            return json(data || {});
        }

        // ----- 登录 -----
        if (path === '/api/login' && request.method === 'POST') {
            const { password } = await request.json();
            if (!password) return json({ error: '缺少密码' }, 400);

            // 第一次：如果 KV 没存密码，使用环境变量 INITIAL_PASSWORD 比对，并保存其哈希
            let storedHash = await env.SITE_KV.get('admin_password_hash');
            if (!storedHash) {
                const initial = env.INITIAL_PASSWORD;
                if (!initial) return json({ error: '系统未初始化，请联系管理员设置 INITIAL_PASSWORD 环境变量' }, 500);
                if (password !== initial) return json({ error: '密码错误' }, 401);
                storedHash = await hashPassword(password);
                await env.SITE_KV.put('admin_password_hash', storedHash);
            } else {
                const inputHash = await hashPassword(password);
                if (inputHash !== storedHash) return json({ error: '密码错误' }, 401);
            }

            const token = await signToken(env.JWT_SECRET || 'change-me', {
                role: 'admin',
                exp: Date.now() + 7 * 24 * 60 * 60 * 1000  // 7 天
            });
            return json({ token });
        }

        // ----- 以下需要登录 -----
        const auth = await checkAuth(request, env);
        if (!auth) return json({ error: '未授权' }, 401);

        // 作品 CRUD
        if (path === '/api/admin/works' && request.method === 'GET') {
            const data = await env.SITE_KV.get('works', 'json');
            return json(data || []);
        }
        if (path === '/api/admin/works' && request.method === 'PUT') {
            const arr = await request.json();
            if (!Array.isArray(arr)) return json({ error: '数据格式错误' }, 400);
            await env.SITE_KV.put('works', JSON.stringify(arr));
            return json({ ok: true });
        }

        // 设置
        if (path === '/api/admin/settings' && request.method === 'GET') {
            const data = await env.SITE_KV.get('settings', 'json');
            return json(data || {});
        }
        if (path === '/api/admin/settings' && request.method === 'PUT') {
            const obj = await request.json();
            await env.SITE_KV.put('settings', JSON.stringify(obj));
            return json({ ok: true });
        }

        // 修改密码
        if (path === '/api/admin/password' && request.method === 'PUT') {
            const { password } = await request.json();
            if (!password || password.length < 8) return json({ error: '密码至少 8 位' }, 400);
            const hash = await hashPassword(password);
            await env.SITE_KV.put('admin_password_hash', hash);
            return json({ ok: true });
        }

        // 上传文件到 R2
        const uploadMatch = path.match(/^\/api\/admin\/upload\/(.+)$/);
        if (uploadMatch && request.method === 'PUT') {
            const key = decodeURIComponent(uploadMatch[1]);
            if (!key || key.length > 200) return json({ error: '文件名无效' }, 400);
            const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
            await env.MEDIA_BUCKET.put(key, request.body, {
                httpMetadata: { contentType }
            });
            const publicBase = (env.R2_PUBLIC_URL || '').replace(/\/$/, '');
            const url = publicBase + '/' + encodeURIComponent(key).replace(/%2F/g, '/');
            return json({ ok: true, key, url });
        }

        // 列出 R2 文件
        if (path === '/api/admin/media' && request.method === 'GET') {
            const list = await env.MEDIA_BUCKET.list({ limit: 200 });
            const publicBase = (env.R2_PUBLIC_URL || '').replace(/\/$/, '');
            const items = list.objects.map(o => ({
                key: o.key,
                size: o.size,
                uploaded: o.uploaded,
                url: publicBase + '/' + encodeURIComponent(o.key).replace(/%2F/g, '/')
            }));
            // 按上传时间倒序
            items.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
            return json(items);
        }

        // 删除 R2 文件
        const delMatch = path.match(/^\/api\/admin\/media\/(.+)$/);
        if (delMatch && request.method === 'DELETE') {
            const key = decodeURIComponent(delMatch[1]);
            await env.MEDIA_BUCKET.delete(key);
            return json({ ok: true });
        }

        return json({ error: '路径不存在' }, 404);

    } catch (err) {
        console.error('API error:', err);
        return json({ error: err.message || '服务器错误' }, 500);
    }
}
