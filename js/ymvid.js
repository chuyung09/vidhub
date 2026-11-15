/**
 * 粵漫之家 (ymvid.com/hk) — drpy 源
 *
 * 頁面解析方式與 canton-anime 專案的 scraper.py 相同 (parse_home / parse_list /
 * parse_search / parse_play)，改寫成可直接在 drpy2 引擎上執行：
 *   推薦  首頁各區塊的 .img-container 卡片
 *   列表  /hk/list/{頁}/c{語言}-s{狀態}-v{版本}-l{字母}-t{題材}-y{年份}/{排序}
 *   搜尋  /hk/search?keyword=關鍵字&p=頁，只取 .search-list 裡的 .item-row
 *   詳情  /hk/play/{id} 的 .media-info、.type-row、.intro-detail 與 .play-list 選集
 *   播放  不在這裡解析影片來源，回傳播放頁網址交給 App 嗅探 (parse: 1)
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

    // 不解析影片來源，交給 App 嗅探播放頁
    function play(url) {
        return {parse: 1, jx: 0, url: url};
    }

    return {home: home, category: category, search: search, detail: detail, play: play};
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
    limit: 6,
    double: false,
    推荐: 'js:' + YM_LIB + 'setResult(YM.home());',
    一级: 'js:' + YM_LIB + 'setResult(YM.category(MY_CATE, MY_PAGE, typeof MY_FL === "undefined" ? null : MY_FL));',
    二级: 'js:' + YM_LIB + 'VOD = YM.detail(input);',
    搜索: 'js:' + YM_LIB + 'setResult(YM.search(input, typeof KEY === "undefined" ? "" : KEY, typeof MY_PAGE === "undefined" ? 0 : MY_PAGE));',
};
