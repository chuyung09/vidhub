/**
 * TVB Anywhere 北美 (tvbanywherena.com) — drpy 源
 *
 * 抓取方法與本專案 Python 端 (tvbweb/scraper.py、vod.py、nextjson.py) 相同，
 * 改寫成可直接在 drpy2 引擎 (TVBox / 影視倉 等) 上執行，不需經過本服務：
 *   列表  解析 ShowCard 卡片 (首頁各列、/browse、/collections/N、/search/關鍵字)
 *   分頁  以分頁列的「目前頁」判斷該頁是否存在 (沒有分頁的合輯會對任何頁碼回傳第 1 頁)
 *   詳情  SeriesHero 區塊 + Next.js __next_f payload 內的 initialEpisodes
 *   播放  播放頁的 Brightcove account/player → policy key → Playback API
 *         (policy key 綁定網域，請求必須帶 TVB 的 Origin/Referer)
 *
 * 每部劇有兩條線路：
 *   TVB 粵語    1080p MP4，只有主聲道 (粵語)，與 Python 端實際播放的檔案相同
 *   TVB 多聲道  HLS，自動調整畫質，帶粵語／國語／越語聲道 (有哪些視該劇而定)，
 *               由播放器選擇，中文裝置通常會先選到國語
 *
 * 上游只開放美國／加拿大 IP (regionsAllowed: US,CA)，播放裝置本身必須在該地區。
 *
 * 分類代號：cN = /collections/N、tN = /browse?type=N、all = /browse。
 * 要增減分類只需改 class_name / class_url；合輯編號可在首頁各列的「查看全部」連結找到。
 *
 * CSS module 類名形如 ShowCard-module__OhPn0W__card，中間的雜湊每次上游改版都會變，
 * 所以一律只比對「模組名 + 元素名」。
 */

// 每個 js: 區塊都是獨立 eval 的，共用函式只能以原始碼字串的形式接在各區塊前面。
// 用 String.raw 是為了讓正則裡的反斜線保持原樣；內容不可出現反引號或 ${。
var TVB_LIB = String.raw`
var TVB = (function () {
    var SITE = 'https://tvbanywherena.com';
    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
    // 播放頁找不到 Brightcove 內嵌資訊時的後備值
    var BC_ACCOUNT = '5324042807001', BC_PLAYER = 't3oBfbU6IW_default';
    // 多聲道線路的集數網址帶這個記號，play() 據此改選 HLS
    var HLS_MARK = '?hls=1';

    function get(url, headers) {
        try {
            var body = headers ? request(url, {headers: headers}) : request(url);
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

    function cls(mod, name) {
        return mod + '-module__[\\w-]+__' + name + '(?![\\w-])';
    }

    // 第一個帶有該類名的元素的 innerHTML (只用在內部不會再巢狀同名標籤的元素)
    function inner(html, mod, name) {
        var m = new RegExp('<(\\w+)\\b[^>]*class="[^"]*' + cls(mod, name) + '[^>]*>([\\s\\S]*?)</\\1>').exec(html);
        return m ? m[2] : '';
    }

    function links(html) {
        var out = [], re = /<a\b([^>]*)>([\s\S]*?)<\/a>/g, m;
        while ((m = re.exec(html))) out.push({tag: m[1], href: attr(m[1], 'href'), body: m[2]});
        return out;
    }

    // 圖片網址最後一段是 base64 的 JSON 參數；列表給的是 228x324 縮圖，放大一倍。
    // force: 不論原尺寸一律改成海報尺寸 (詳情頁的海報原本是 1920 寬)。
    function img(src, force) {
        if (!src) return '';
        src = abs(src);
        try {
            var cut = src.lastIndexOf('/') + 1;
            var conf = JSON.parse(base64Decode(src.substring(cut)));
            var size = conf.edits.resize;
            if (force || (size.width === 228 && size.height === 324)) {
                size.width = 456;
                size.height = 648;
                return src.substring(0, cut) + base64Encode(JSON.stringify(conf));
            }
        } catch (e) {
        }
        return src;
    }

    function cards(html, remark) {
        var out = [], isCard = new RegExp('class="[^"]*' + cls('ShowCard', 'card'));
        links(html).forEach(function (a) {
            if (!isCard.test(a.tag) || a.href.indexOf('/series/') < 0) return;
            var pic = (/<img\b[^>]*>/.exec(a.body) || [''])[0];
            var title = text(inner(a.body, 'ShowCard', 'title')) || attr(pic, 'alt');
            if (!title) return;
            out.push({
                title: title,
                url: abs(a.href),
                img: img(attr(pic, 'src')),
                desc: text(inner(a.body, 'ShowCard', 'status')) || remark || ''
            });
        });
        return out;
    }

    // 請求第 1 頁以外的頁碼時，回應的分頁列必須標示同一頁才算數。
    function onPage(html, pg) {
        if (pg <= 1) return true;
        var m = new RegExp(cls('Pagination', 'pageNumActive') + '[^>]*>\\s*(\\d+)\\s*<').exec(html);
        return !!m && parseInt(m[1], 10) === pg;
    }

    function list(url, pg) {
        pg = parseInt(pg, 10) || 1;
        var html = get(url + (pg > 1 ? (url.indexOf('?') < 0 ? '?' : '&') + 'page=' + pg : ''));
        return onPage(html, pg) ? cards(html) : [];
    }

    function home() {
        var html = get(SITE + '/'), out = [], seen = {};
        function add(items) {
            items.forEach(function (it) {
                if (!seen[it.url]) {
                    seen[it.url] = 1;
                    out.push(it);
                }
            });
        }
        var rows = html.split(new RegExp('<section\\b[^>]*class="[^"]*' + cls('ContentRow', 'section')));
        for (var i = 1; i < rows.length; i++) {
            var shelf = inner(rows[i], 'ContentRow', 'title').replace(/<span\b[\s\S]*?<\/span>/g, '');
            add(cards(rows[i], text(shelf)));
        }
        if (!out.length) add(cards(html));
        return out;
    }

    function category(cate, pg, fl) {
        cate = String(cate);
        fl = fl || {};
        var coll = /^c(.+)$/.exec(cate);
        if (coll) return list(SITE + '/collections/' + coll[1], pg);
        var query = [], type = /^t(\d+)$/.exec(cate);
        if (type) query.push('type=' + type[1]);
        ['genre', 'year', 'updating', 'prod_region', 'sup_lang'].forEach(function (k) {
            if (fl[k]) query.push(k + '=' + encodeURIComponent(fl[k]));
        });
        return list(SITE + '/browse' + (query.length ? '?' + query.join('&') : ''), pg);
    }

    // input 形如 {host}/search/關鍵字?page=N；引擎不一定會替關鍵字做 URL 編碼。
    function search(input, key, pg) {
        var m = /\/search\/([^?#]*)(?:\?(?:[^#]*&)?page=(\d+))?/.exec(String(input)) || [];
        if (!key) {
            key = m[1] || '';
            try {
                key = decodeURIComponent(key);
            } catch (e) {
            }
        }
        return list(SITE + '/search/' + encodeURIComponent(key), pg || m[2]);
    }

    // 把所有 self.__next_f.push([1,"..."]) 的字串接回完整的 flight 串流
    // (分段邊界是任意的，一筆資料可能橫跨多個 push)。
    function flight(html) {
        var out = [], re = /self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g, m;
        while ((m = re.exec(html))) {
            try {
                var chunk = JSON.parse(m[1]);
                if (chunk[0] === 1 && typeof chunk[1] === 'string') out.push(chunk[1]);
            } catch (e) {
            }
        }
        return out.join('');
    }

    // 從 at 位置的 [ 或 { 掃到對應的結尾並解析
    function jsonAt(s, at) {
        var depth = 0, quoted = false;
        for (var i = at; i < s.length; i++) {
            var ch = s.charAt(i);
            if (quoted) {
                if (ch === '\\') i++;
                else if (ch === '"') quoted = false;
            } else if (ch === '"') {
                quoted = true;
            } else if (ch === '[' || ch === '{') {
                depth++;
            } else if (ch === ']' || ch === '}') {
                if (--depth === 0) {
                    try {
                        return JSON.parse(s.substring(at, i + 1));
                    } catch (e) {
                        return null;
                    }
                }
            } else if (depth === 0) {
                return null;
            }
        }
        return null;
    }

    // 直接在串流文字裡找 "key": 後面的陣列／物件，不依賴上游把元件包了幾層。
    function prop(stream, key) {
        var needle = '"' + key + '":', from = 0, at;
        while ((at = stream.indexOf(needle, from)) >= 0) {
            from = at + needle.length;
            var value = jsonAt(stream, from);
            if (value) return value;
        }
        return null;
    }

    function detail(url) {
        url = abs(url);
        var html = get(url);
        var hero = inner(html, 'SeriesHero', 'hero');
        var slug = (/\/series\/([^\/?#]+)/.exec(url) || [])[1] || '';
        var years = [], genres = [], actors = [], m;

        var re = /<span\b[^>]*chipStatic[^>]*>([\s\S]*?)<\/span>/g;
        while ((m = re.exec(hero))) genres.push(text(m[1]));
        links(hero).forEach(function (a) {
            var name = text(a.body);
            if (!name) return;
            if (/[?&]artist_id=/.test(a.href)) actors.push(name);
            else if (/[?&]year=/.test(a.href)) years.push(name);
            else if (/[?&](genre|type)=/.test(a.href)) genres.push(name);
        });

        var plays = [];
        (prop(flight(html), 'initialEpisodes') || []).forEach(function (ep, i) {
            if (!ep || !ep.id) return;
            var name = String(ep.name || '第' + (i + 1) + '集') + (ep.description ? ' - ' + ep.description : '');
            // $ 與 # 是 vod_play_url 的分隔符
            plays.push(name.replace(/[$#]/g, ' ').replace(/\s+/g, ' ') + '$' + SITE + '/watch/' + slug + '/' + ep.id);
        });
        if (!plays.length) {
            m = /href="(\/watch\/[^"]+)"/.exec(hero);
            if (m) plays.push('立即觀看$' + SITE + text(m[1]));
        }

        var poster = (/<img\b[^>]*>/.exec(inner(hero, 'SeriesHero', 'poster')) || [''])[0];
        return {
            vod_name: text(inner(hero, 'SeriesHero', 'title')) || slug,
            vod_pic: img(attr(poster, 'src'), true),
            type_name: genres.join(','),
            vod_year: years.join(','),
            vod_area: '',
            vod_remarks: text(inner(hero, 'SeriesHero', 'status')) || (plays.length ? '共' + plays.length + '集' : ''),
            vod_actor: actors.join(','),
            vod_director: '',
            // hero 裡的簡介被截斷，完整版在下方的 About 區塊
            vod_content: text(inner(html, 'AboutSection', 'synopsis')) || text(inner(hero, 'SeriesHero', 'synopsis')),
            vod_play_from: 'TVB 粵語$$$TVB 多聲道',
            vod_play_url: plays.length ? plays.join('#') + '$$$' + plays.join(HLS_MARK + '#') + HLS_MARK : ''
        };
    }

    function policyKey(account, player, cacheKey) {
        var base = 'https://players.brightcove.net/' + account + '/' + player + '/', pk = '';
        try {
            pk = JSON.parse(get(base + 'config.json')).video_cloud.policy_key || '';
        } catch (e) {
        }
        if (!pk) {
            var m = /policyKey\s*:\s*["']([^"']+)["']/.exec(get(base + 'index.min.js'));
            pk = m ? m[1] : '';
        }
        if (pk) {
            try {
                setItem(cacheKey, pk);
            } catch (e) {
            }
        }
        return pk;
    }

    function playback(account, player, video) {
        var api = 'https://edge.api.brightcove.com/playback/v1/accounts/' + account + '/videos/' + video;
        var cacheKey = 'tvb_pk_' + account + '_' + player, pk = '';
        try {
            pk = getItem(cacheKey, '') || '';
        } catch (e) {
        }
        var cached = !!pk;
        for (var round = 0; round < 2; round++) {
            if (!pk) pk = policyKey(account, player, cacheKey);
            if (!pk) return null;
            try {
                var data = JSON.parse(get(api, {
                    'User-Agent': UA,
                    'Accept': 'application/json;pk=' + pk,
                    'Origin': SITE,
                    'Referer': SITE + '/'
                }));
                if (data && data.sources) return data;
            } catch (e) {
            }
            // 快取的 key 可能已被輪替：重抓一次；剛抓的 key 還失敗就不必再試
            if (!cached) return null;
            cached = false;
            pk = '';
        }
        return null;
    }

    // 預設與 Python 端 (yt-dlp 的預設選擇) 一致：優先用漸進式 MP4，它只有主聲道 (粵語)。
    // HLS/DASH 同時帶粵語、國語、越語聲道，雖然標了粵語為預設，
    // 但播放器多半依裝置語系挑選，中文裝置會選到國語配音，所以只在多聲道線路才優先。
    function pickSource(data, multi) {
        var best = '', bestScore = -1;
        data.sources.forEach(function (s) {
            if (!s || !s.src) return;
            var score = /mpegurl/i.test(s.type || '') ? (multi ? 40 : 20) : /dash/i.test(s.type || '') ? 10
                : /mp4/i.test(s.container || '') ? 30 + (s.avg_bitrate || 0) / 1e9 : 0;
            if (/^https:/.test(s.src)) score += 5;
            if (s.key_systems) score -= 100;
            if (score > bestScore) {
                bestScore = score;
                best = s.src;
            }
        });
        return best;
    }

    function play(url) {
        var multi = url.indexOf(HLS_MARK) >= 0;
        url = url.split('?')[0];
        // 解析不到直連時交給播放器嗅探播放頁
        var sniff = {parse: 1, jx: 0, url: url};
        try {
            var video = (/\/watch\/[^\/?#]+\/([^\/?#]+)/.exec(url) || [])[1];
            if (!video) return sniff;
            var html = get(url), account = BC_ACCOUNT, player = BC_PLAYER;
            var m = /players\.brightcove\.net\/(\w+)\/([\w-]+)\/index\.html/.exec(html);
            if (m) {
                account = m[1];
                player = m[2];
            } else if ((m = /players\.brightcove\.net\/(\d+)\/index\.min\.js/.exec(html))) {
                account = m[1];
                player = 'default_default';
            }
            var data = playback(account, player, video);
            var src = data ? pickSource(data, multi) : '';
            return src ? {parse: 0, jx: 0, url: src} : sniff;
        } catch (e) {
            return sniff;
        }
    }

    return {home: home, category: category, search: search, detail: detail, play: play};
})();
`;

var TVB_FILTER = (function () {
    function select(key, name, pairs) {
        var value = [{n: '全部', v: ''}];
        pairs.forEach(function (p) {
            value.push({n: p[0], v: p[1]});
        });
        return {key: key, name: name, value: value};
    }

    // 類型代碼來自上游 /browse 的篩選器：g02xx 屬於劇集，g07xx 屬於綜藝
    var drama = [['動作', 'g0201'], ['商戰', 'g0202'], ['喜劇', 'g0203'], ['警匪', 'g0204'], ['家庭倫理', 'g0205'],
        ['奇幻', 'g0206'], ['溫馨', 'g0207'], ['古裝', 'g0208'], ['律政', 'g0210'], ['劇情', 'g0212'],
        ['宮鬥', 'g0213'], ['愛情', 'g0215'], ['科幻', 'g0216'], ['懸疑', 'g0218'], ['職場', 'g0219']];
    var variety = [['烹飪', 'g0702'], ['娛樂', 'g0704'], ['飲食', 'g0705'], ['玄學', 'g0706'], ['遊戲', 'g0707'],
        ['資訊', 'g0708'], ['生活', 'g0709'], ['音樂', 'g0710'], ['真人秀', 'g0711'], ['訪談', 'g0714'],
        ['旅遊', 'g0715']];

    var years = [];
    for (var y = new Date().getFullYear(); y >= 2020; y--) years.push([String(y), String(y)]);
    ['2010s', '2000s', '1990s', '1980s', '1970s'].forEach(function (d) {
        years.push([d, d]);
    });

    var common = [
        select('year', '年份', years),
        select('updating', '更新狀態', [['全集', 'false'], ['正在更新', 'true']]),
        select('prod_region', '地區', [['香港', '0'], ['中國大陸', '1'], ['北美', '2'], ['台灣', '3']]),
        select('sup_lang', '語言', [['英文字幕', 'en_sub'], ['越語配音', 'vn_dub'], ['國語聲道', 'sc_dub']])
    ];
    return {
        t2: [select('genre', '類型', drama)].concat(common),
        t7: [select('genre', '類型', variety)].concat(common),
        t5: common,
        t4: common,
        t3: common,
        t1: common,
        t6: common,
        all: [select('genre', '類型', drama.concat(variety))].concat(common)
    };
})();

var rule = {
    title: 'TVB Anywhere 北美',
    host: 'https://tvbanywherena.com',
    // 實際網址由各 js: 區塊依 MY_CATE / MY_PAGE / MY_FL 自行組出，這裡只是給引擎的佔位
    url: '/fyclass?page=fypage',
    searchUrl: '/search/**?page=fypage',
    searchable: 2,
    quickSearch: 0,
    filterable: 1,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    },
    timeout: 15000,
    class_name: '周一至五更新&周末更新&劇集&綜藝節目&處境喜劇&新聞&電影&演唱會&特備節目&全部節目',
    class_url: 'c74&c85&t2&t7&t5&t4&t3&t1&t6&all',
    filter: TVB_FILTER,
    play_parse: true,
    lazy: 'js:' + TVB_LIB + 'input = TVB.play(input);',
    limit: 6,
    double: false,
    推荐: 'js:' + TVB_LIB + 'setResult(TVB.home());',
    一级: 'js:' + TVB_LIB + 'setResult(TVB.category(MY_CATE, MY_PAGE, typeof MY_FL === "undefined" ? null : MY_FL));',
    二级: 'js:' + TVB_LIB + 'VOD = TVB.detail(input);',
    搜索: 'js:' + TVB_LIB + 'setResult(TVB.search(input, typeof KEY === "undefined" ? "" : KEY, typeof MY_PAGE === "undefined" ? 0 : MY_PAGE));',
};
