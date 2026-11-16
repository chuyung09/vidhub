/**
 * 粵漫之家 (ymvid.com/hk) — drpy 源
 *
 * 頁面解析方式與 canton-anime 專案的 scraper.py 相同 (parse_home / parse_list /
 * parse_search / parse_play)，改寫成可直接在 drpy2 引擎上執行：
 *   推薦  首頁各區塊的 .img-container 卡片
 *   列表  /hk/list/{頁}/c{語言}-s{狀態}-v{版本}-l{字母}-t{題材}-y{年份}/{排序}
 *   搜尋  /hk/search?keyword=關鍵字&p=頁，只取 .search-list 裡的 .item-row
 *   詳情  /hk/play/{id} 的 .media-info、.type-row、.intro-detail 與 .play-list 選集
 *   播放  與 canton-anime 的 ymvid.py 相同的 XXTEA 解密：解開選集的 data-play-url、
 *         取 /allocate/secure_key 組出 HLS 清單網址 (只能用一次)。有 drpy 本地代理的
 *         App 先取回清單、經 proxy_rule 交給播放器；沒有的 (DMPlayer) 直接交出網址
 *         與 Browser-Code 標頭，由 App 自己的代理取用 (parse: 0)；
 *         解不出來時才退回播放頁網址交給 App 嗅探 (parse: 1，sniffer / isVideo)
 *
 * 來源站對訪客只開放列表與搜尋的第 1–4 頁，第 5 頁起會被導去登入頁 (此時回傳空列表)。
 * 想看更後面的內容請用篩選 (年份／題材／字母) 把範圍縮小。
 *
 * 分類代號：c1 粵語、c2 國語、s1 連載、s2 完結、v2 劇場版、all 全部。
 * 代號的字母就是它佔用的網址欄位，該分類下不會再出現同一欄位的篩選。
 */

// 每個 js: 區塊都是獨立 eval 的，共用函式只能以原始碼字串的形式接在各區塊前面。
// 用 String.raw 是為了讓正則裡的反斜線保持原樣；內容不可出現反引號或 ${。
var YM_LIB = String.raw`
var YM = (function () {
    var SITE = 'https://ymvid.com';
    var HOME = SITE + '/hk';

    // 不傳 obj，讓引擎套用 rule.headers
    function get(url) {
        try {
            var body = request(url);
            return typeof body === 'string' ? body : '';
        } catch (e) {
            return '';
        }
    }

    function abs(href) {
        if (/^https?:/.test(href)) return href;
        if (href.indexOf('//') === 0) return 'https:' + href;
        return SITE + (href.charAt(0) === '/' ? '' : '/') + href;
    }

    // HTML 片段 → 純文字 (去標籤、解實體、壓縮空白)
    function text(html) {
        return String(html == null ? '' : html)
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<[^>]+>/g, '')
            .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
            .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ').replace(/^ | $/g, '');
    }

    function attr(tag, name) {
        var m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag);
        return m ? text(m[1]) : '';
    }

    // 第一個帶有該類名的元素的 innerHTML (只用在內部不會再巢狀同名標籤的元素)
    function inner(html, name) {
        var m = new RegExp('<(\\w+)\\b[^>]*class="(?:[^"]*\\s)?' + name + '(?:\\s[^"]*)?"[^>]*>([\\s\\S]*?)</\\1>').exec(html);
        return m ? m[2] : '';
    }

    function firstTag(html, name) {
        return (new RegExp('<' + name + '\\b[^>]*>').exec(html) || [''])[0];
    }

    // 以某個類名的開始標籤切段，回傳每個元素開頭到下一個同類元素之前的片段
    function blocks(html, name) {
        var parts = html.split(new RegExp('<\\w+\\b[^>]*class="(?:[^"]*\\s)?' + name + '(?:\\s[^"]*)?"[^>]*>'));
        return parts.slice(1);
    }

    // 首頁的連結帶著最新一集的編號 (/hk/play/7038/119192)，一律收斂成劇集網址
    function seriesUrl(href) {
        var m = /\/play\/(\d+)/.exec(href || '');
        return m ? HOME + '/play/' + m[1] : '';
    }

    function playLink(html) {
        var m = /<a\b[^>]*\shref="([^"]*\/play\/\d+[^"]*)"/.exec(html);
        return m ? text(m[1]) : '';
    }

    function unique(items) {
        var out = [], seen = {};
        items.forEach(function (it) {
            if (it.url && !seen[it.url]) {
                seen[it.url] = 1;
                out.push(it);
            }
        });
        return out;
    }

    // 首頁與列表頁的卡片。兩邊的 <a> 包住的範圍不同，所以以 .img-container 為單位取值。
    function cards(html) {
        var out = [];
        blocks(html, 'img-container').forEach(function (block) {
            var pic = firstTag(block, 'img');
            var title = attr(pic, 'alt');
            var url = seriesUrl(playLink(block));
            if (!url || !title) return;
            out.push({
                title: title,
                url: url,
                img: pic ? abs(attr(pic, 'src')) : '',
                desc: text(inner(block, 'tips')) || text(inner(block, 'tag'))
            });
        });
        return unique(out);
    }

    function home() {
        return cards(get(HOME));
    }

    function category(cate, pg, fl) {
        cate = String(cate);
        fl = fl || {};
        pg = parseInt(pg, 10) || 1;
        var dims = {c: '0', s: '0', v: '0', l: '0', t: '0', y: '0'};
        Object.keys(dims).forEach(function (k) {
            if (fl[k] && /^\w+$/.test(String(fl[k]))) dims[k] = String(fl[k]);
        });
        var fixed = /^([csv])(\d+)$/.exec(cate);
        if (fixed) dims[fixed[1]] = fixed[2];
        var sort = /^\w+$/.test(String(fl.by || '')) ? fl.by : 'time_desc';
        var path = 'c' + dims.c + '-s' + dims.s + '-v' + dims.v + '-l' + dims.l + '-t' + dims.t + '-y' + dims.y;
        return cards(get(HOME + '/list/' + pg + '/' + path + '/' + sort));
    }

    // input 形如 {host}/hk/search?keyword=關鍵字&p=N；引擎不一定會替關鍵字做 URL 編碼。
    function search(input, key, pg) {
        var m = /[?&]keyword=([^&#]*)/.exec(String(input)) || [];
        if (!key) {
            key = m[1] || '';
            try {
                key = decodeURIComponent(key);
            } catch (e) {
            }
        }
        pg = parseInt(pg, 10) || parseInt((/[?&]p=(\d+)/.exec(String(input)) || [])[1], 10) || 1;
        if (!key) return [];
        var html = get(HOME + '/search?keyword=' + encodeURIComponent(key) + (pg > 1 ? '&p=' + pg : ''));
        // 只取搜尋結果，旁邊 <aside> 的相關推薦不算
        var at = html.search(/class="(?:[^"]*\s)?search-list(?:\s[^"]*)?"/);
        if (at < 0) return [];
        var list = html.substring(at), end = list.search(/<aside\b|class="(?:[^"]*\s)?pagination(?:\s[^"]*)?"/);
        if (end > 0) list = list.substring(0, end);

        var out = [];
        blocks(list, 'item-row').forEach(function (row) {
            var url = seriesUrl(playLink(row));
            var pic = firstTag(row, 'img');
            // 圖片 alt 裡的關鍵字高亮是被跳脫過的 HTML，解開後要再去一次標籤
            var title = text(inner(row, 'item-title')) || text(attr(pic, 'alt'));
            if (!url || !title) return;
            // 縮圖上的語言標籤 (粵語／國語)
            var lang = text((/<span\b[^>]*>([\s\S]*?)<\/span>/.exec(inner(row, 'item-thumb')) || [])[1]);
            var state = text(inner(row, 'pic-tag'));
            out.push({
                title: title,
                url: url,
                img: pic ? abs(attr(pic, 'src')) : '',
                desc: [lang, state].filter(function (x) { return x; }).join(' · '),
                content: text(inner(row, 'item-desc'))
            });
        });
        return unique(out);
    }

    // .type-row 是「標籤: 值」，標籤可能是簡體或繁體
    function meta(html) {
        var out = {}, re = /<div\b[^>]*class="(?:[^"]*\s)?type-row(?:\s[^"]*)?"[^>]*>\s*<span\b[^>]*>([\s\S]*?)<\/span>([\s\S]*?)<\/div>/g, m;
        while ((m = re.exec(html))) out[text(m[1]).replace(/[:：\s]+$/, '')] = text(m[2]);
        return out;
    }

    function pick(obj, keys) {
        for (var i = 0; i < keys.length; i++) if (obj[keys[i]]) return obj[keys[i]];
        return '';
    }

    function episodes(html) {
        var at = html.search(/<ul\b[^>]*class="(?:[^"]*\s)?play-list(?:\s[^"]*)?"/), out = [];
        if (at < 0) return out;
        var list = html.substring(at), end = list.indexOf('</ul>');
        if (end > 0) list = list.substring(0, end);
        var re = /<li\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/g, m;
        while ((m = re.exec(list))) {
            var href = attr(m[1], 'href');
            if (href.indexOf('/play/') < 0) continue;
            var name = text((/<em\b[^>]*>([\s\S]*?)<\/em>/.exec(m[2]) || [])[1] || m[2]) || String(out.length + 1);
            if (/^\d+$/.test(name)) name = '第' + name + '集';
            // $ 與 # 是 vod_play_url 的分隔符
            out.push(name.replace(/[$#]/g, ' ').replace(/\s+/g, ' ') + '$' + abs(href));
        }
        return out;
    }

    function detail(url) {
        url = seriesUrl(url) || abs(url);
        var html = get(url);
        var info = meta(html), plays = episodes(html);
        var head = html.substring(Math.max(html.search(/class="(?:[^"]*\s)?media-info(?:\s[^"]*)?"/), 0));
        var poster = firstTag(inner(html, 'media-thumb'), 'img');
        var status = pick(info, ['状态', '狀態']);
        return {
            vod_name: text((/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(head) || [])[1]) || attr(poster, 'alt'),
            vod_pic: poster ? abs(attr(poster, 'src')) : '',
            type_name: pick(info, ['类型', '類型']).replace(/\s*\/\s*/g, ','),
            vod_year: pick(info, ['播出']),
            vod_area: '',
            vod_remarks: [status, plays.length ? '共' + plays.length + '集' : ''].filter(function (x) { return x; }).join(' · '),
            vod_actor: '',
            vod_director: '',
            vod_content: text(inner(html, 'intro-detail')).replace(/^[简簡]介\s*[:：]\s*/, ''),
            vod_play_from: plays.length ? '粵漫之家' : '',
            vod_play_url: plays.join('#')
        };
    }

    // ---------------------------------------------------------------------
    // 取片：與 canton-anime 的 ymvid.py / scraper.py fetch_m3u8 相同的 XXTEA 流程
    //   1. 播放頁 .play-list 每集 <li> 的 data-play-url 是 XXTEA 密文，解開得到
    //      /allocate/playlist/<HASH>?t=…，只取 path
    //   2. GET /allocate/secure_key，回應 data 以 XXTEA 解開即為這次的 secure key
    //   3. 播放清單 = SITE + path + ?t=<secureKey>&vId=<#main data-id>
    //   4. XHR 帶 X-Client-Type: web 與 Browser-Code (= browser-code-v1 cookie)，
    //      值是 XXTEA("<visitorId>_<UTC yyyy-MM-dd>")
    // 金鑰寫死在來源站帶版本號的 xxtea.js / script.js / detail-play.js；播放壞了先回去對照。
    // ---------------------------------------------------------------------
    var XXTEA_KEY = 'RuoYi_XXTEA_Key1';
    var DELTA = 0x9E3779B9;
    // md5('canton-anime')：固定的 32 位 hex visitorId，與 canton-anime 送出相同的 code
    var VISITOR_ID = 'f0b8a02182d6738d553138ac0b7d838b';
    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

    function utf8Bytes(str) {
        var bin = unescape(encodeURIComponent(str)), out = [];
        for (var i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
        return out;
    }

    function utf8String(bytes) {
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return decodeURIComponent(escape(bin));
    }

    // base64url，不補 =
    function b64urlEncode(bytes) {
        var out = '';
        for (var i = 0; i < bytes.length; i += 3) {
            var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
            out += B64.charAt(n >> 18 & 63) + B64.charAt(n >> 12 & 63);
            if (i + 1 < bytes.length) out += B64.charAt(n >> 6 & 63);
            if (i + 2 < bytes.length) out += B64.charAt(n & 63);
        }
        return out;
    }

    // 同時接受 base64url 與標準 base64，有無 padding 皆可
    function b64urlDecode(str) {
        str = String(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=\s]/g, '');
        var out = [], buf = 0, bits = 0;
        for (var i = 0; i < str.length; i++) {
            var v = B64.indexOf(str.charAt(i));
            if (v < 0) throw new Error('XXTEA: bad base64');
            buf = (buf << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out.push((buf >> bits) & 255);
            }
        }
        return out;
    }

    function toWords(bytes, withLength) {
        var n = Math.ceil(bytes.length / 4), words = [];
        for (var i = 0; i < n; i++) {
            words.push(((bytes[i * 4] || 0) | ((bytes[i * 4 + 1] || 0) << 8) |
                ((bytes[i * 4 + 2] || 0) << 16) | ((bytes[i * 4 + 3] || 0) << 24)) >>> 0);
        }
        if (withLength) words.push(bytes.length);
        return words;
    }

    function fromWords(words, withLength) {
        var size = words.length * 4, out = [];
        if (withLength) {
            var real = words[words.length - 1];
            size -= 4;
            if (real < size - 3 || real > size) throw new Error('XXTEA: bad length word');
            size = real;
        }
        for (var i = 0; i < size; i++) out.push((words[i >> 2] >>> ((i & 3) * 8)) & 255);
        return out;
    }

    function mx(sum, y, z, p, e, k) {
        return ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (k[(p & 3) ^ e] ^ z))) >>> 0;
    }

    function encryptWords(v, k) {
        var n = v.length - 1;
        if (n < 1) return v;
        var z = v[n], y, sum = 0, e, p, q = Math.floor(6 + 52 / (n + 1));
        while (q-- > 0) {
            sum = (sum + DELTA) >>> 0;
            e = (sum >>> 2) & 3;
            for (p = 0; p < n; p++) {
                y = v[p + 1];
                z = v[p] = (v[p] + mx(sum, y, z, p, e, k)) >>> 0;
            }
            y = v[0];
            z = v[n] = (v[n] + mx(sum, y, z, n, e, k)) >>> 0;
        }
        return v;
    }

    function decryptWords(v, k) {
        var n = v.length - 1;
        if (n < 1) return v;
        var y = v[0], z, e, p, sum = (Math.floor(6 + 52 / (n + 1)) * DELTA) >>> 0;
        while (sum !== 0) {
            e = (sum >>> 2) & 3;
            for (p = n; p > 0; p--) {
                z = v[p - 1];
                y = v[p] = (v[p] - mx(sum, y, z, p, e, k)) >>> 0;
            }
            z = v[n];
            y = v[0] = (v[0] - mx(sum, y, z, 0, e, k)) >>> 0;
            sum = (sum - DELTA) >>> 0;
        }
        return v;
    }

    // xxtea.js XXTEAUtils.encrypt：UTF-8 → XXTEA (長度附在最後一個 word) → base64url
    function xxteaEncrypt(plain) {
        if (!plain) return '';
        var words = encryptWords(toWords(utf8Bytes(plain), true), toWords(utf8Bytes(XXTEA_KEY), false));
        return b64urlEncode(fromWords(words, false));
    }

    function xxteaDecrypt(token) {
        if (!token) return '';
        var words = decryptWords(toWords(b64urlDecode(token), false), toWords(utf8Bytes(XXTEA_KEY), false));
        return utf8String(fromWords(words, true));
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // script.js getBrowserCode；每次重算讓日期保持在當天 (UTC)
    function browserCode() {
        var d = new Date();
        return xxteaEncrypt(VISITOR_ID + '_' + d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()));
    }

    // http.js sendRequest 對每個 XHR 加的標頭
    function xhrHeaders(code) {
        return {
            'User-Agent': UA,
            'Referer': HOME,
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Client-Type': 'web',
            'Browser-Code': code,
            'Cookie': 'browser-code-v1=' + code
        };
    }

    // #main 的 data-id (videoId)、目前這集的 data-series-id 與它的 data-play-url 密文
    function episodeSource(html) {
        var main = (/<\w+\b[^>]*\sid="main"[^>]*>/.exec(html) || [''])[0];
        var videoId = attr(main, 'data-id');
        if (!videoId) return null;
        var current = attr(main, 'data-series-id'), items = [], re = /<li\b[^>]*\sdata-play-url="[^"]*"[^>]*>/g, m;
        while ((m = re.exec(html))) {
            items.push({
                sid: attr(m[0], 'data-series-id'),
                enc: attr(m[0], 'data-play-url'),
                active: /\sclass="(?:[^"]*\s)?active(?:\s[^"]*)?"/.test(m[0])
            });
        }
        var item = items.filter(function (it) { return current && it.sid === current; })[0] ||
            items.filter(function (it) { return it.active; })[0] || items[0];
        if (!item || !item.enc) return null;
        return {videoId: videoId, seriesId: item.sid || current, enc: item.enc};
    }

    // detail-play.js getSecureKey
    function secureKey(code) {
        var body = JSON.parse(request(SITE + '/allocate/secure_key', {headers: xhrHeaders(code)}) || '{}');
        if (body.code !== 0 || !body.data) throw new Error('secure_key refused: ' + body.msg);
        return xxteaDecrypt(body.data);
    }

    // 播放清單網址是一次性的：同一個網址第二次 GET 就回 403，而且沒有 .m3u8 副檔名、
    // content-type 是 text/plain。App 與播放器常會對同一網址請求不只一次 (探測格式、
    // 去廣告、重試)，直接把網址交給播放器會播不了。所以和 canton-anime 一樣由這裡取回
    // 清單內容，再經 drpy 本地代理 (proxy_rule) 以 m3u8 的 MIME 提供給播放器。
    // 清單內容快取 60 秒 (同 canton-anime 的 YMVID_MANIFEST_TTL)，掛在全域物件上，
    // 讓 lazy 取到的內容能直接給 proxy 用；拿不到快取時 proxy 會自己重新解析。
    var TTL = 60000;
    var ROOT = typeof globalThis !== 'undefined' ? globalThis : this;
    var CACHE = ROOT.__ymvidM3u8 || (ROOT.__ymvidM3u8 = {});

    // 清單裡若有相對路徑 (目前都是 CDN 絕對網址)，以清單網址補成絕對網址
    function absolutize(m3u8, base) {
        var origin = /^https?:\/\/[^\/]+/.exec(base)[0], dir = base.split('?')[0].replace(/[^\/]*$/, '');
        return m3u8.split(/\r?\n/).map(function (line) {
            if (!line || line.charAt(0) === '#' || /^https?:/.test(line)) return line;
            return line.charAt(0) === '/' ? origin + line : dir + line;
        }).join('\n');
    }

    // 某一集這次的一次性播放清單網址與 browser code；拿不到回傳 null
    function locate(url) {
        var src = episodeSource(get(url));
        if (!src) return null;
        var path = xxteaDecrypt(src.enc).split('?t=')[0];
        if (path.indexOf('/allocate/') < 0) return null;
        var code = browserCode();
        var key = secureKey(code);
        return {src: src, code: code, key: key, list: SITE + path + '?t=' + encodeURIComponent(key) + '&vId=' + src.videoId};
    }

    // 播放器開播時的回報；不送也能拿到完整清單，失敗不影響播放
    function reportPlay(loc) {
        try {
            request(SITE + '/video/check_play_status', {
                method: 'POST',
                headers: Object.assign({'Content-Type': 'application/json'}, xhrHeaders(loc.code)),
                body: {videoId: loc.src.videoId, id: loc.src.seriesId, sessionId: loc.key}
            });
        } catch (e) {
        }
    }

    // 某一集的 HLS 清單內容 (scraper.py fetch_m3u8)；拿不到回傳空字串
    function manifest(url) {
        url = abs(url);
        var hit = CACHE[url];
        if (hit && hit.exp > Date.now()) return hit.text;

        var loc = locate(url);
        if (!loc) return '';
        // hls.js 取清單時只帶 cookie
        var text = request(loc.list, {headers: {'User-Agent': UA, 'Referer': url, 'Cookie': 'browser-code-v1=' + loc.code}}) || '';
        if (!/^\s*#EXTM3U/.test(text)) return '';
        text = absolutize(text, loc.list);
        reportPlay(loc);

        Object.keys(CACHE).forEach(function (k) {
            if (CACHE[k].exp <= Date.now()) delete CACHE[k];
        });
        CACHE[url] = {exp: Date.now() + TTL, text: text};
        return text;
    }

    // 有 drpy 本地代理的 App (TVBox 系，會提供 getProxy)：先取回清單內容，交給本地代理網址。
    function viaLocalProxy(url) {
        if (!manifest(url)) return null;
        return {
            parse: 0,
            jx: 0,
            // 結尾的 .m3u8 讓只看網址判斷格式的播放器把它當 HLS
            url: getProxyUrl() + '&url=' + encodeURIComponent(abs(url)) + '&ext=.m3u8',
            format: 'application/x-mpegURL'
        };
    }

    // 沒有 drpy 本地代理的 App (例如 DMPlayer)：直接交出一次性清單網址，這裡不能先取，
    // 否則網址就用掉了。
    //   - 結尾的 #.m3u8 只是格式提示：播放器看網址就知道是 HLS，不會先發探測請求
    //     (Range／HEAD 也會把網址用掉)；# 之後的部分不會送到伺服器。
    //   - Browser-Code 標頭單獨就能通過驗證；它也是 AVPlayer 無法自行設定的標頭，
    //     DMPlayer 會因此改走自己的本機代理，以 index.m3u8 / HLS MIME 交給 AVPlayer。
    //   - 不帶 Referer：分段在公開 CDN 上 (舊 CDN 有 Referer 防盜鏈)。
    function direct(url) {
        var loc = locate(abs(url));
        if (!loc) return null;
        reportPlay(loc);
        return {
            parse: 0,
            jx: 0,
            url: loc.list + '#.m3u8',
            header: JSON.stringify({'User-Agent': UA, 'Browser-Code': loc.code, 'Cookie': 'browser-code-v1=' + loc.code})
        };
    }

    // 解不出來時退回交給 App 嗅探播放頁
    function play(url) {
        try {
            var out = typeof getProxy === 'function' ? viaLocalProxy(url) : direct(url);
            if (out) return out;
        } catch (e) {
            log('粵漫之家 解密取片失敗，改用嗅探: ' + e.message);
        }
        return {parse: 1, jx: 0, url: url};
    }

    // proxy_rule：/proxy?do=js&url=<播放頁> → [狀態碼, MIME, 清單內容]
    function proxy(params) {
        var url = String((params || {}).url || '');
        if (!/^https?:/.test(url)) {
            try {
                url = decodeURIComponent(url);
            } catch (e) {
            }
        }
        if (!/^https:\/\/ymvid\.com\//.test(url)) return [403, 'text/plain', 'Forbidden'];
        var text = '';
        try {
            text = manifest(url);
        } catch (e) {
            return [502, 'text/plain', 'ymvid: ' + e.message];
        }
        return text ? [200, 'application/vnd.apple.mpegurl', text] : [404, 'text/plain', 'Not Found'];
    }

    return {home: home, category: category, search: search, detail: detail, play: play, proxy: proxy};
})();
`;

var YM_FILTER = (function () {
    function select(key, name, pairs, noAll) {
        var value = noAll ? [] : [{n: '全部', v: ''}];
        pairs.forEach(function (p) {
            value.push({n: p[0], v: String(p[1])});
        });
        return {key: key, name: name, value: value};
    }

    // 題材編號來自來源站列表頁的篩選器 (中間有缺號)
    var genres = [['搞笑', 1], ['運動', 2], ['勵志', 3], ['熱血', 4], ['戰鬥', 5], ['經濟', 6], ['校園', 7], ['青春', 8],
        ['愛情', 9], ['冒險', 10], ['後宮', 11], ['百合', 12], ['治癒', 13], ['蘿莉', 14], ['魔法', 15], ['懸疑', 16],
        ['推理', 17], ['奇幻', 18], ['科幻', 19], ['神魔', 21], ['恐怖', 22], ['機器人', 24], ['戰爭', 25], ['犯罪', 26],
        ['歷史', 27], ['社會', 28], ['職場', 29], ['劇情', 30], ['教育', 34], ['親子', 35], ['真人', 36], ['歌舞', 37],
        ['卡牌', 38], ['美少女', 39], ['競技', 40], ['吸血鬼', 41], ['泡麵番', 43]];

    // 年份編號 = 年份 - 1999 (2001 → 2 … 2026 → 27)，1 是「更早」
    var years = [];
    for (var y = new Date().getFullYear(); y >= 2001; y--) years.push([String(y), y - 1999]);
    years.push(['更早', 1]);

    var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(function (ch) {
        return [ch, ch];
    });
    letters.push(['其他', 100]);

    var dims = {
        c: select('c', '語言', [['粵語', 1], ['國語', 2]]),
        s: select('s', '狀態', [['連載', 1], ['完結', 2], ['未播放', 3]]),
        v: select('v', '版本', [['TV', 1], ['劇場版', 2], ['OVA', 3], ['其他', 5]]),
        t: select('t', '題材', genres),
        y: select('y', '年份', years),
        l: select('l', '字母', letters)
    };
    var sort = select('by', '排序', [['最近更新', 'time_desc'], ['最新開播', 'begin_desc'], ['最多播放', 'play_desc'],
        ['最早開播', 'begin_asc']], true);

    // 分類本身佔用的欄位 (代號的第一個字母) 不再提供篩選
    function without(fixed) {
        var out = [];
        ['c', 's', 'v', 't', 'y', 'l'].forEach(function (k) {
            if (k !== fixed) out.push(dims[k]);
        });
        out.push(sort);
        return out;
    }

    return {c1: without('c'), c2: without('c'), s1: without('s'), s2: without('s'), v2: without('v'), all: without('')};
})();

var rule = {
    title: '粵漫之家',
    host: 'https://ymvid.com',
    homeUrl: '/hk',
    // 實際網址由各 js: 區塊依 MY_CATE / MY_PAGE / MY_FL 自行組出，這裡只是給引擎的佔位
    url: '/hk/list/fypage/fyclass/time_desc',
    searchUrl: '/hk/search?keyword=**&p=fypage',
    searchable: 2,
    quickSearch: 0,
    filterable: 1,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Referer': 'https://ymvid.com/hk'
    },
    timeout: 15000,
    class_name: '粵語動畫&國語動畫&連載動畫&完結動畫&劇場版&全部動畫',
    class_url: 'c1&c2&s1&s2&v2&all',
    filter: YM_FILTER,
    play_parse: true,
    lazy: 'js:' + YM_LIB + 'input = YM.play(input);',
    // lazy 回傳的本地代理網址由這裡提供 HLS 清單內容
    proxy_rule: 'js:' + YM_LIB + 'input = YM.proxy(input);',
    // 嗅探只是後備：lazy 解不出直連時才回傳播放頁 (parse: 1) 交給 App 嗅探。
    // 播放頁一載入，站方播放器就會自己請求 HLS 清單 /allocate/playlist/…，但這個網址沒有
    // .m3u8 副檔名，只認副檔名的預設嗅探抓不到 (.ts 分段要按下播放才會出現)，
    // 所以開啟輔助嗅探，直接指出哪個請求是影片。
    sniffer: 1,
    isVideo: 'js:input = /\\/allocate\\/playlist\\/|\\.m3u8(\\?|$)/.test(input);',
    limit: 6,
    double: false,
    推荐: 'js:' + YM_LIB + 'setResult(YM.home());',
    一级: 'js:' + YM_LIB + 'setResult(YM.category(MY_CATE, MY_PAGE, typeof MY_FL === "undefined" ? null : MY_FL));',
    二级: 'js:' + YM_LIB + 'VOD = YM.detail(input);',
    搜索: 'js:' + YM_LIB + 'setResult(YM.search(input, typeof KEY === "undefined" ? "" : KEY, typeof MY_PAGE === "undefined" ? 0 : MY_PAGE));',
};
