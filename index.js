/**
 * MusicFlow API — Node.js 音乐代理服务
 *
 * 三层架构中的核心数据层：接收前端请求 → 调用网易云 API → 返回清洗后的数据。
 * 内置节流(throttleApi)、限流重试、批量封面/URL预取。
 *
 * @module index
 */
require('dotenv').config()
const express = require('express')
const { search, song_url, song_detail, lyric: getLyric } = require('NeteaseCloudMusicApi')
const app = express()

/** 预定义推荐关键词池，首页每次随机取4个，避免推荐固化 */
const KEYWORD_POOL = [
  '起风了', '光年之外', '飞鸟和蝉', '错位时空', '少年', '体面', '南山南', '成都', '后来',
  '孤勇者', '芒种', '踏山河', '少年中国说', '海底', '赤伶', '大鱼', '消愁'
]

function pickKeywords(count = 4) {
  const shuffled = [...KEYWORD_POOL].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count)
}

const MUSIC_U = process.env.MUSIC_U || ''
const COOKIE = MUSIC_U ? 'MUSIC_U=' + MUSIC_U + '; appver=8.0.0; os=pc;' : ''

/**
 * 节流包装器 — 防止短时间内过多请求触发网易云 405 限流。
 *
 * 每次调用间隔至少 THROTTLE=400ms。遇到 405 限流时自动重试最多2次，
 * 每次等待递增的退避时间(2s, 4s)。重试耗尽后返回空数据而非抛异常，
 * 保证前端不崩溃。
 *
 * @param {Function} fn — 返回 Promise 的网易云 API 调用
 * @returns {Promise<Object>} API 响应体，失败时返回空数据容器
 */
let lastCall = 0
const THROTTLE = 400

async function throttleApi(fn) {
  const now = Date.now()
  const wait = Math.max(0, lastCall + THROTTLE - now)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastCall = Date.now()
  // Retry up to 2 times on rate limit
  for (let i = 0; i < 3; i++) {
    const result = await fn()
    if (result.body?.code !== 405 && result.status !== 405) return result
    if (i < 2) await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
  }
  return { body: { code: 200, result: { songs: [] }, playlists: [], data: [] }, status: 200 }
}

// Search + batch fetch covers and audio URLs
app.get('/playable', async (req, res) => {
  try {
    const q = req.query.q
    if (!q) return res.json({ code: 400, data: [] })
    const result = await throttleApi(() => search({ keywords: q, limit: 30, cookie: COOKIE }))
    const raw = (result.body?.result?.songs || [])
      .filter((s) => COOKIE ? s.duration > 30000 && s.fee !== 8 : s.fee === 0)
      .slice(0, 12)

    const ids = raw.map((s) => s.id)
    const idsStr = ids.join(',')
    let coverMap = {}, urlMap = {}

    if (idsStr) {
      try {
        const [detail, urlResult] = await Promise.all([
          song_detail({ ids: idsStr, cookie: COOKIE }),
          song_url({ id: idsStr, cookie: COOKIE }),
        ])
        ;(detail.body?.songs || []).forEach((s) => { coverMap[s.id] = s.al?.picUrl || '' })
        ;(urlResult.body?.data || []).forEach((u) => { if (u.url) urlMap[u.id] = u.url })
      } catch {}
    }

    const songs = raw.map((s) => ({
      id: s.id,
      name: s.name,
      artist: (s.artists || []).map((a) => a.name).join(' / '),
      cover: coverMap[s.id] || s.artists?.[0]?.img1v1Url || '',
      duration: s.duration || 0,
      url: urlMap[s.id] || '',
    }))
    res.json({ code: 200, data: songs })
  } catch (e) {
    res.json({ code: 500, data: [], error: e.message })
  }
})

// Song detail + url + lyric
app.get('/song-info', async (req, res) => {
  try {
    const id = Number(req.query.id)
    const [detail, url, lrc] = await Promise.all([
      song_detail({ ids: String(id), cookie: COOKIE }),
      song_url({ id, cookie: COOKIE }),
      getLyric({ id, cookie: COOKIE }),
    ])
    const s = (detail.body?.songs || [])[0] || {}
    res.json({ code: 200, data: {
      id: s.id, name: s.name,
      artist: (s.ar || []).map((a) => a.name).join(' / '),
      cover: (s.al || {}).picUrl || '',
      duration: s.dt || 0,
      url: (url.body?.data || [{}])[0].url || '',
      lyric: (lrc.body?.lrc || {}).lyric || '',
    }})
  } catch (e) {
    res.json({ code: 500, data: null, error: e.message })
  }
})

// Hot songs — search multiple real keywords to get playable tracks
app.get('/hot', async (req, res) => {
  try {
    const keywords = pickKeywords(9)
    let allSongs = []
    for (const kw of keywords) {
      try {
        const result = await throttleApi(() => search({ keywords: kw, limit: 5, cookie: COOKIE }))
        ;(result.body?.result?.songs || []).forEach((s) => {
          if ((COOKIE ? s.duration > 30000 && s.fee !== 8 : s.fee === 0) && !allSongs.find((x) => x.id === s.id)) allSongs.push(s)
        })
      } catch {}
      if (allSongs.length >= 12) break
    }
    const raw = allSongs.slice(0, 12)
    const ids = raw.map((s) => s.id)
    let coverMap = {}, urlMap = {}
    if (ids.length) {
      try {
        const idsStr = ids.join(',')
        const [detail, urlR] = await Promise.all([
          song_detail({ ids: idsStr, cookie: COOKIE }),
          song_url({ id: idsStr, cookie: COOKIE }),
        ])
        ;(detail.body?.songs || []).forEach((s) => { coverMap[s.id] = s.al?.picUrl || '' })
        ;(urlR.body?.data || []).forEach((u) => { if (u.url) urlMap[u.id] = u.url })
      } catch {}
    }
    const songs = raw.map((s) => ({ id: s.id, name: s.name, artist: (s.artists || []).map((a) => a.name).join(' / '), cover: coverMap[s.id] || '', duration: s.duration || 0, url: urlMap[s.id] || '' }))
    res.json({ code: 200, data: songs })
  } catch (e) { res.json({ code: 500, data: [] }) }
})

// Playlists
app.get('/playlists', async (req, res) => {
  try { const { top_playlist, personalized: pl } = require('NeteaseCloudMusicApi'); const result = await top_playlist({ limit: 10, order: 'hot', cookie: COOKIE }); res.json({ code: 200, data: (result.body?.playlists || []).slice(0, 8).map((p) => ({ id: p.id, name: p.name, cover: p.coverImgUrl || '', count: p.playCount || 0 })) }) }
  catch { res.json({ code: 500, data: [] }) }
})

// Playlist detail
app.get('/playlist-detail', async (req, res) => {
  try { const { playlist_detail } = require('NeteaseCloudMusicApi'); const r = await playlist_detail({ id: Number(req.query.id), cookie: COOKIE }); const pl = r.body?.playlist || {}; res.json({ code: 200, data: { id: pl.id, name: pl.name, cover: pl.coverImgUrl || '', tracks: (pl.tracks || []).filter((t) => COOKIE ? true : t.fee === 0).slice(0, 30).map((t) => ({ id: t.id, name: t.name, artist: (t.ar || []).map((a) => a.name).join(' / '), cover: (t.al || {}).picUrl || '', duration: t.dt || 0 })) } }) }
  catch (e) { res.json({ code: 500, data: null }) }
})

app.get('/lyric', async (req, res) => {
  try { const r = await getLyric({ id: Number(req.query.id), cookie: COOKIE }); res.json({ code: 200, data: { lyric: (r.body?.lrc || {}).lyric || '' } }) }
  catch (e) { res.json({ code: 500, data: null }) }
})

// Kugou search
app.get('/kugou-search', async (req, res) => {
  try {
    const q = req.query.q; if (!q) return res.json({ code: 400, data: [] })
    const http = require('http')
    const url = 'http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=' + encodeURIComponent(q) + '&page=1&pagesize=10'
    const resp = await new Promise((resolve, reject) => { http.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => { let body = ''; r.on('data', (c) => body += c); r.on('end', () => resolve(JSON.parse(body))) }).on('error', reject) })
    res.json({ code: 200, data: (resp.data?.info || []).map((s) => ({ id: 0, kgHash: s.hash, name: s.songname?.replace(/<[^>]+>/g, '') || '', artist: s.singername || '', cover: '', duration: s.duration * 1000 })) })
  } catch (e) { res.json({ code: 500, data: [] }) }
})

// 新歌速递
app.get('/new-songs', async (req, res) => {
  try {
    const { top_song } = require('NeteaseCloudMusicApi')
    const r = await top_song({ type: 0, cookie: COOKIE })
    const raw = (r.body?.data || []).filter((s) => s.fee !== 8 && s.duration > 30000).slice(0, 12)
    const ids = raw.map((s) => s.id).join(',')
    let coverMap = {}, urlMap = {}
    if (ids) {
      try {
        const [d, u] = await Promise.all([song_detail({ ids, cookie: COOKIE }), song_url({ id: ids, cookie: COOKIE })])
        ;(d.body?.songs || []).forEach((s) => { coverMap[s.id] = s.al?.picUrl || '' })
        ;(u.body?.data || []).forEach((x) => { if (x.url) urlMap[x.id] = x.url })
      } catch {}
    }
    res.json({ code: 200, data: raw.map((s) => ({ id: s.id, name: s.name, artist: (s.artists || []).map((a) => a.name).join(' / '), cover: coverMap[s.id] || '', duration: s.duration || 0, url: urlMap[s.id] || '' })) })
  } catch (e) { res.json({ code: 500, data: [] }) }
})

// 精品歌单
app.get('/top-playlists', async (req, res) => {
  try {
    const { top_playlist } = require('NeteaseCloudMusicApi')
    const r = await top_playlist({ limit: 20, order: 'hot', cookie: COOKIE })
    const playlists = (r.body?.playlists || []).slice(0, 10).map((p) => ({ id: p.id, name: p.name, cover: p.coverImgUrl || '', count: p.playCount || 0, creator: (p.creator || {}).nickname || '', trackCount: p.trackCount || 0 }))
    res.json({ code: 200, data: playlists })
  } catch (e) { res.json({ code: 500, data: [] }) }
})

// 分类推荐 (多关键词预设)
app.get('/category', async (req, res) => {
  try {
    const cat = req.query.cat || '华语'
    const r = await search({ keywords: cat + ' 热门', limit: 20, cookie: COOKIE })
    const raw = (r.body?.result?.songs || []).filter((s) => s.fee !== 8 && s.duration > 30000).slice(0, 8)
    const ids = raw.map((s) => s.id).join(',')
    let coverMap = {}, urlMap = {}
    if (ids) {
      try {
        const [d, u] = await Promise.all([song_detail({ ids, cookie: COOKIE }), song_url({ id: ids, cookie: COOKIE })])
        ;(d.body?.songs || []).forEach((s) => { coverMap[s.id] = s.al?.picUrl || '' })
        ;(u.body?.data || []).forEach((x) => { if (x.url) urlMap[x.id] = x.url })
      } catch {}
    }
    res.json({ code: 200, data: raw.map((s) => ({ id: s.id, name: s.name, artist: (s.artists || []).map((a) => a.name).join(' / '), cover: coverMap[s.id] || '', duration: s.duration || 0, url: urlMap[s.id] || '' })) })
  } catch (e) { res.json({ code: 500, data: [] }) }
})

// 个性化推荐 — 基于cookie的推荐内容
app.get('/personalized', async (req, res) => {
  try {
    const { personalized: pl } = require('NeteaseCloudMusicApi')
    const r = await pl({ limit: 12, cookie: COOKIE })
    const playlists = (r.body?.result || []).map((p) => ({
      id: p.id, name: p.name, cover: p.picUrl || '',
      count: p.playCount || 0, creator: '', trackCount: p.trackCount || 0,
    }))
    res.json({ code: 200, data: playlists })
  } catch (e) { res.json({ code: 500, data: [] }) }
})

// 首页聚合推荐 — 合并热门+新歌+个性化
app.get('/home-feed', async (req, res) => {
  try {
    const results = { hot: [], newSongs: [], playlists: [] }

    // 并行获取
    const keywords = pickKeywords(4)
    const searchResults = await Promise.allSettled(
      keywords.map((kw) => throttleApi(() => search({ keywords: kw, limit: 3, cookie: COOKIE })))
    )
    const seen = new Set()
    let allSongs = []
    searchResults.forEach((r) => {
      if (r.status === 'fulfilled') {
        (r.value.body?.result?.songs || []).forEach((s) => {
          if (s.fee !== 8 && s.duration > 30000 && !seen.has(s.id)) {
            seen.add(s.id); allSongs.push(s)
          }
        })
      }
    })
    // Get covers + URLs for songs
    const ids = allSongs.slice(0, 8).map((s) => s.id).join(',')
    let coverMap = {}, urlMap = {}
    if (ids) {
      try {
        const [d, u] = await Promise.all([
          song_detail({ ids, cookie: COOKIE }),
          song_url({ id: ids, cookie: COOKIE }),
        ])
        ;(d.body?.songs || []).forEach((s) => { coverMap[s.id] = s.al?.picUrl || '' })
        ;(u.body?.data || []).forEach((x) => { if (x.url) urlMap[x.id] = x.url })
      } catch {}
    }
    results.hot = allSongs.slice(0, 8).map((s) => ({
      id: s.id, name: s.name, artist: (s.artists || []).map((a) => a.name).join(' / '),
      cover: coverMap[s.id] || '', duration: s.duration || 0, url: urlMap[s.id] || '',
    }))

    // New songs
    try {
      const { top_song } = require('NeteaseCloudMusicApi')
      const ts = await throttleApi(() => top_song({ type: 0, cookie: COOKIE }))
      const raw = (ts.body?.data || []).filter((s) => s.fee !== 8).slice(0, 6)
      const nids = raw.map((s) => s.id).join(',')
      if (nids) {
        const [nd, nu] = await Promise.all([
          song_detail({ ids: nids, cookie: COOKIE }),
          song_url({ id: nids, cookie: COOKIE }),
        ])
        let nc = {}, nuMap = {}
        ;(nd.body?.songs || []).forEach((s) => { nc[s.id] = s.al?.picUrl || '' })
        ;(nu.body?.data || []).forEach((x) => { if (x.url) nuMap[x.id] = x.url })
        results.newSongs = raw.map((s) => ({ id: s.id, name: s.name, artist: (s.artists || []).map((a) => a.name).join(' / '), cover: nc[s.id] || '', duration: s.duration || 0, url: nuMap[s.id] || '' }))
      }
    } catch {}

    // Playlists
    try {
      const { top_playlist: tp } = require('NeteaseCloudMusicApi')
      const tpr = await throttleApi(() => tp({ limit: 12, order: 'hot', cookie: COOKIE }))
      results.playlists = (tpr.body?.playlists || []).slice(0, 9).map((p) => ({
        id: p.id, name: p.name, cover: p.coverImgUrl || '', count: p.playCount || 0,
        creator: (p.creator || {}).nickname || '', trackCount: p.trackCount || 0,
      }))
    } catch {}

    res.json({ code: 200, data: results })
  } catch (e) { res.json({ code: 500, data: { hot: [], newSongs: [], playlists: [] } }) }
})

// Banner
app.get('/banners', async (req, res) => {
  try {
    const { banner } = require('NeteaseCloudMusicApi')
    const r = await banner({ type: 0 })
    res.json({ code: 200, data: (r.body?.banners || []).map((b) => ({ imageUrl: b.imageUrl || b.pic, typeTitle: b.typeTitle, titleColor: b.titleColor })) })
  } catch (e) { res.json({ code: 500, data: [] }) }
})

// Artists
app.get('/top-artists', async (req, res) => {
  try {
    const { top_artists } = require('NeteaseCloudMusicApi')
    const r = await top_artists({ limit: 30, offset: 0 })
    res.json({ code: 200, data: (r.body?.artists || []).map((a) => ({ id: a.id, name: a.name, picUrl: a.picUrl || a.img1v1Url, musicSize: a.musicSize || 0 })) })
  } catch (e) { res.json({ code: 500, data: [] }) }
})

// Top MV
app.get('/top-mv', async (req, res) => {
  try {
    const { top_mv } = require('NeteaseCloudMusicApi')
    const r = await top_mv({ limit: 30 })
    res.json({ code: 200, data: (r.body?.data || []).map((m) => ({ id: m.id, name: m.name, cover: m.cover, playCount: m.playCount, artistName: m.artistName })) })
  } catch (e) { res.json({ code: 500, data: [] }) }
})

// 排行榜列表 (飙升榜/新歌榜/原创榜/热歌榜)
app.get('/charts', async (req, res) => {
  try {
    const { toplist } = require('NeteaseCloudMusicApi')
    const r = await toplist()
    const lists = (r.body?.list || []).slice(0, 20).map((l) => ({
      id: l.id, name: l.name, cover: l.coverImgUrl || l.picUrl || '', updateTime: l.updateFrequency || l.updateTime || '', trackCount: l.trackCount || l.trackNumberUpdateTime || 0,
    }))
    res.json({ code: 200, data: lists })
  } catch (e) { res.json({ code: 500, data: [] }) }
})

// 排行榜详情
app.get('/chart-detail', async (req, res) => {
  try {
    const { playlist_detail } = require('NeteaseCloudMusicApi')
    const id = Number(req.query.id)
    const r = await playlist_detail({ id, cookie: COOKIE })
    const pl = r.body?.playlist || {}
    const tracks = (pl.tracks || []).filter((t) => COOKIE ? true : t.fee === 0).slice(0, 20).map((t) => ({
      id: t.id, name: t.name, artist: (t.ar || []).map((a) => a.name).join(' / '),
      cover: (t.al || {}).picUrl || '', duration: t.dt || 0,
    }))
    res.json({ code: 200, data: { id: pl.id, name: pl.name, cover: pl.coverImgUrl || '', tracks } })
  } catch (e) { res.json({ code: 500, data: null }) }
})

// QQ音乐搜索
app.get('/qq-search', async (req, res) => {
  try {
    const q = req.query.q || ''
    const https = require('https')
    const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?ct=24&qqmusic_ver=1298&new_json=1&remoteplace=txt.yqq.song&t=0&aggr=1&cr=1&p=1&n=20&w=' + encodeURIComponent(q)
    const resp = await new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://y.qq.com' } }, (r) => {
        let body = ''; r.on('data', (c) => body += c); r.on('end', () => { try { resolve(JSON.parse(body)) } catch(e) { reject(e) } })
      }).on('error', reject)
    })
    const songs = (resp.data?.song?.list || []).map((s) => ({
      id: s.id || s.mid, name: s.name || s.title, artist: (s.singer || []).map((a) => a.name).join(' / '),
      album: (s.album || {}).name || '', cover: '', duration: (s.interval || 0),
      source: 'qq',
    }))
    res.json({ code: 200, data: songs })
  } catch (e) { res.json({ code: 500, data: [], error: e.message }) }
})

// Audio streaming proxy
app.get('/stream', (req, res) => {
  const id = req.query.id
  if (!id) return res.status(400).json({ error: 'id required' })
  const { song_url } = require('NeteaseCloudMusicApi')
  const cookie = process.env.MUSIC_U || ''
  const cookieStr = cookie ? 'MUSIC_U=' + cookie + '; appver=8.0.0; os=pc;' : ''
  song_url({ id, br: 999000 }, cookieStr).then(r => {
    const url = r.body?.data?.[0]?.url
    if (!url) return res.status(404).json({ error: 'no audio url' })
    const http = require('http')
    const https = require('https')
    const client = url.startsWith('https') ? https : http
    const cdnReq = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com' } }, (cdnRes) => {
      if (cdnRes.statusCode >= 400) { res.status(502).json({ error: 'CDN error ' + cdnRes.statusCode }); return }
      res.set({ 'Content-Type': cdnRes.headers['content-type'] || 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' })
      res.flushHeaders()
      cdnRes.pipe(res)
    })
    cdnReq.on('error', (e) => { try { res.status(502).json({ error: e.message }) } catch {} })
  }).catch(e => res.status(500).json({ error: e.message }))
})

const PORT = process.env.PORT || 3000
app.get('/', (_req, res) => res.json({ ok: true, uptime: process.uptime() }))
app.listen(PORT, () => console.log('Music API on :' + PORT))
