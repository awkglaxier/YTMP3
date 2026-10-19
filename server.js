// ==========================================================
// ไฟล์: server.js
// คำอธิบาย: AwokenYT — ตัวกลางระหว่างหน้าเว็บกับ yt-dlp
//   รับลิ้ง YouTube หลายลิ้งจากหน้าเว็บ แล้วจัดคิวโหลดเป็น mp3
//   พร้อมกันตามค่า maxConcurrent (จำนวนที่โหลดได้ล้วนๆ ในเวลาเดียวกัน)
//   zero-dependency: ใช้แค่โมดูลพื้นฐานของ Node.js ไม่ต้อง npm install
//   API:
//     GET  /api/health     สถานะ yt-dlp/ffmpeg + โฟลเดอร์ปลายทาง + คิว
//     GET  /api/status     รายการงานทั้งหมด (สถานะ, %, ความเร็ว)
//     POST /api/download   { links: [] } เพิ่มลิ้งเข้าคิว
//     POST /api/cancel     { id } ยกเลิกรายการเดียว
//     POST /api/cancel-all ยกเลิกทุกรายการที่ยังไม่เสร็จ
//     POST /api/clear      ล้างรายการที่เสร็จ/ผิดพลาด/ยกเลิกแล้ว
//     POST /api/reveal     { id } เปิดโฟลเดอร์แล้วชี้ไปที่ไฟล์
//     POST /api/open-folder เปิดโฟลเดอร์ปลายทาง
//     GET  /api/files      รายชื่อไฟล์เพลงในโฟลเดอร์ปลายทาง + tag ID3 (สำหรับหน้าจัดชื่อไฟล์)
//     POST /api/rename     { pattern, files: [id] } เปลี่ยนชื่อไฟล์ตาม pattern (2-phase กันชน)
//   รองรับการเปิดหน้าเว็บทั้งแบบ file:// (CORS: *) และ http://localhost:<port>
// ==========================================================

'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const RenameCore = require('./web/rename-core.js')

const rootDir = __dirname
const isWin = process.platform === 'win32'

// ----------------------------------------------------------
// คอนฟิก (โหลดจาก config.json ถ้ามี ไม่มีก็สร้างค่าเริ่มต้นให้)
// ----------------------------------------------------------
const defaultConfig = {
  port: 5577,
  host: '127.0.0.1',
  ytDlpPath: isWin ? 'yt-dlp.exe' : 'yt-dlp',
  ffmpegPath: '',
  downloadDir: 'downloads',
  maxConcurrent: 3,
  audioQuality: '0',
  filenameTemplate: '%(title)s.%(ext)s',
  embedMetadata: true
}

let config = { ...defaultConfig }
const configPath = path.join(rootDir, 'config.json')
try {
  if (fs.existsSync(configPath)) {
    config = Object.assign({}, defaultConfig, JSON.parse(fs.readFileSync(configPath, 'utf8')))
  } else {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2))
  }
} catch (err) {
  console.warn('[config] อ่าน config.json ไม่สำเร็จ ใช้ค่าเริ่มต้นแทน:', err.message)
}

const downloadDir = path.resolve(rootDir, config.downloadDir)
fs.mkdirSync(downloadDir, { recursive: true })

// หาตำแหน่ง yt-dlp: ใช้ที่ระบุใน config ก่อน ถ้าไม่มีไฟล์จริงลองโฟลเดอร์ bin/
function resolveYtDlpBin() {
  const fallbackName = isWin ? 'yt-dlp.exe' : 'yt-dlp'
  const configured = String(config.ytDlpPath || '').trim()
  const candidates = []
  if (configured) candidates.push(path.isAbsolute(configured) ? configured : path.resolve(rootDir, configured))
  candidates.push(path.join(rootDir, 'bin', fallbackName))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return configured || fallbackName
}
const ytDlpBin = resolveYtDlpBin()

// ----------------------------------------------------------
// ตรวจว่า yt-dlp / ffmpeg ใช้ได้หรือไม่ (ตรวจรอบเดียวตอนเปิด)
// ----------------------------------------------------------
let ytDlpVersion = null

function probeYtDlp() {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn(ytDlpBin, ['--version'])
    } catch (err) {
      return resolve(null)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => { out += d })
    child.on('error', () => { ytDlpVersion = null; resolve(null) })
    child.on('close', (code) => {
      ytDlpVersion = code === 0 ? out.trim().split(/\r?\n/)[0] : null
      resolve(ytDlpVersion)
    })
  })
}

let ffmpegOk = null

function probeFfmpeg() {
  if (config.ffmpegPath) {
    ffmpegOk = fs.existsSync(config.ffmpegPath)
    return
  }
  const child = spawn(isWin ? 'ffmpeg.exe' : 'ffmpeg', ['-version'], { stdio: 'ignore' })
  child.on('error', () => { ffmpegOk = false })
  child.on('close', (code) => { ffmpegOk = code === 0 })
}

// ----------------------------------------------------------
// คิวงาน: จำกัดจำนวนโหลดพร้อมกันด้วย maxConcurrent
// สถานะงาน: queued → downloading → converting → done | error | canceled
// ----------------------------------------------------------
const jobs = new Map()
const queue = []
let activeCount = 0
let jobSeq = 0

const TERMINAL = ['done', 'error', 'canceled']
const isTerminal = (job) => TERMINAL.includes(job.status)

function serializeJob(job) {
  return {
    id: job.id,
    url: job.url,
    status: job.status,
    title: job.title,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    size: job.size,
    file: job.file,
    error: job.error
  }
}

function addLinks(links) {
  let added = 0
  let skipped = 0
  for (const raw of Array.isArray(links) ? links : []) {
    const url = String(raw || '').trim()
    if (!/^https?:\/\//i.test(url)) { skipped++; continue }
    const busy = [...jobs.values()].some((j) => j.url === url && !isTerminal(j))
    if (busy) { skipped++; continue }
    const job = {
      id: 'j' + (++jobSeq).toString(36) + '-' + Date.now().toString(36),
      url,
      status: 'queued',
      title: '',
      percent: 0,
      speed: '',
      eta: '',
      size: '',
      file: '',
      error: '',
      proc: null,
      cancelRequested: false
    }
    jobs.set(job.id, job)
    queue.push(job)
    added++
  }
  pump()
  return { added, skipped }
}

function pump() {
  while (activeCount < Math.max(1, config.maxConcurrent | 0) && queue.length > 0) {
    startJob(queue.shift())
  }
}

function buildArgs(url) {
  const args = [
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', String(config.audioQuality || '0'),
    '--newline',
    '--progress',
    '--no-overwrites',
    '--no-playlist',
    '-o', path.join(downloadDir, config.filenameTemplate)
  ]
  if (config.embedMetadata) args.push('--embed-metadata')
  if (config.ffmpegPath) args.push('--ffmpeg-location', config.ffmpegPath)
  args.push(url)
  return args
}

function startJob(job) {
  activeCount++
  job.status = 'downloading'
  let proc
  try {
    proc = spawn(ytDlpBin, buildArgs(job.url))
  } catch (err) {
    job.status = 'error'
    job.error = 'เรียก yt-dlp ไม่สำเร็จ: ' + err.message
    activeCount--
    pump()
    return
  }
  job.proc = proc
  console.log('[yt-dlp] เริ่มโหลด:', job.url)

  feedLines(proc.stdout, (line) => handleLine(job, line))
  feedLines(proc.stderr, (line) => handleLine(job, line))

  proc.on('error', (err) => {
    if (!job.cancelRequested) {
      job.error = err.code === 'ENOENT'
        ? 'หา yt-dlp ไม่เจอ — ติดตั้งให้เรียกจาก PATH ได้ หรือระบุไฟล์ใน config.ytDlpPath'
        : 'spawn error: ' + err.message
    }
  })

  proc.on('close', (code) => {
    activeCount--
    job.proc = null
    if (job.cancelRequested) {
      job.status = 'canceled'
      job.error = ''
    } else if (code === 0 && !job.error) {
      job.status = 'done'
      job.percent = 100
      job.speed = ''
      if (!job.title) job.title = titleFromFile(job.file) || job.url
      console.log('[yt-dlp] เสร็จ:', job.title || job.url)
    } else {
      job.status = 'error'
      if (!job.error) job.error = 'yt-dlp จบการทำงานด้วยรหัส ' + code
      console.warn('[yt-dlp] พลาด:', job.url, '→', job.error)
    }
    pump()
  })
}

function feedLines(stream, onLine) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buf += chunk
    const parts = buf.split(/\r\n|\n|\r/)
    buf = parts.pop()
    for (const line of parts) {
      const text = line.trim()
      if (text) onLine(text)
    }
  })
  stream.on('end', () => {
    const text = buf.trim()
    if (text) onLine(text)
  })
}

const progressRegex = /^\[download\]\s+([\d.]+)%\s+of\s+(~?\s*[\d.]+\s*[KMG]?i?B)(?:\s+at\s+(\S+?\/s|Unknown\s*B\/s))?(?:\s+ETA\s+(\S+))?/i
const destinationRegex = /^\[download\]\s+Destination:\s*(.+)$/
const extractRegex = /^\[ExtractAudio\]\s+Destination:\s*(.+)$/
const alreadyRegex = /^\[download\]\s+(.+?)\s+has already been downloaded$/
const errorRegex = /^ERROR:\s*(.+)$/

function handleLine(job, line) {
  let m = line.match(progressRegex)
  if (m) {
    job.percent = parseFloat(m[1])
    job.size = m[2].replace(/\s+/g, ' ')
    job.speed = m[3] || ''
    job.eta = m[4] || ''
    if (job.percent >= 100) job.speed = ''
    return
  }
  m = line.match(destinationRegex)
  if (m) {
    if (!job.title) job.title = titleFromFile(m[1])
    return
  }
  m = line.match(extractRegex)
  if (m) {
    job.status = 'converting'
    job.file = m[1]
    return
  }
  m = line.match(alreadyRegex)
  if (m) {
    if (!job.file) job.file = m[1]
    job.percent = 100
    if (!job.title) job.title = titleFromFile(m[1])
    return
  }
  m = line.match(errorRegex)
  if (m) {
    job.error = m[1].slice(0, 300)
  }
}

function titleFromFile(file) {
  if (!file) return ''
  const base = path.basename(file).replace(/\.[^.]+$/, '')
  return base.replace(/\s*\[[\w-]{11}\]\s*$/, '').trim()
}

function cancelJob(job) {
  if (isTerminal(job)) return
  if (job.status === 'queued') {
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
    job.status = 'canceled'
    return
  }
  job.cancelRequested = true
  if (job.proc && job.proc.pid) {
    if (isWin) {
      spawn('taskkill', ['/pid', String(job.proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      job.proc.kill('SIGKILL')
    }
  } else {
    job.status = 'canceled'
  }
}

function cancelAll() {
  for (const job of jobs.values()) cancelJob(job)
}

function clearFinished() {
  let removed = 0
  for (const [id, job] of jobs) {
    if (isTerminal(job)) {
      jobs.delete(id)
      removed++
    }
  }
  return removed
}

function reveal(job) {
  const target = job && job.file && fs.existsSync(job.file) ? job.file : downloadDir
  if (isWin) {
    const args = job && job.file && fs.existsSync(job.file) ? ['/select,', path.resolve(target)] : [downloadDir]
    spawn('explorer', args, { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('xdg-open', [downloadDir], { detached: true, stdio: 'ignore' }).unref()
  }
}

// ----------------------------------------------------------
// จัดชื่อไฟล์เพลง: อ่านรายการ + เปลี่ยนชื่อตาม pattern
// รหัสไฟล์ (id) เป็น base64url ของชื่อไฟล์ — ถอดกลับแล้วตรวจ path เสมอ
// เพื่อไม่ให้ไปแตะไฟล์นอกโฟลเดอร์ปลายทาง
// ----------------------------------------------------------
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.opus', '.wma', '.aac'])

function fileIdEncode(name) {
  return Buffer.from(name, 'utf8').toString('base64url')
}

function fileIdDecode(id) {
  const name = Buffer.from(String(id), 'base64url').toString('utf8')
  const full = path.resolve(downloadDir, name)
  // กัน path traversal: ต้องอยู่ในโฟลเดอร์ปลายทางเท่านั้น
  if (!full.startsWith(downloadDir + path.sep)) return null
  return full
}

// อ่านไบต์แรกของไฟล์พอสำหรับ ID3v2 + 128 ไบต์ท้ายสำหรับ ID3v1
function readTagBytes(full) {
  let fd
  try {
    fd = fs.openSync(full, 'r')
    const head = Buffer.alloc(1024 * 1024)
    const headBytes = fs.readSync(fd, head, 0, head.length, 0)
    const stat = fs.fstatSync(fd)
    const tail = Buffer.alloc(Math.min(128, stat.size))
    if (tail.length) fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length)
    return Buffer.concat([head.subarray(0, headBytes), tail])
  } catch (err) {
    return Buffer.alloc(0)
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd) } catch (e) { /* ผ่าน */ }
  }
}

function listAudioFiles() {
  let entries
  try {
    entries = fs.readdirSync(downloadDir, { withFileTypes: true })
  } catch (err) {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!AUDIO_EXTS.has(path.extname(entry.name).toLowerCase())) continue
    const full = path.join(downloadDir, entry.name)
    let size = 0
    let mtime = ''
    try {
      const stat = fs.statSync(full)
      size = stat.size
      mtime = stat.mtime.toISOString()
    } catch (err) { /* ไฟล์หายระหว่างอ่าน — ข้าม */ }
    const tags = RenameCore.parseId3Tags(readTagBytes(full))
    files.push({
      id: fileIdEncode(entry.name),
      name: entry.name,
      base: RenameCore.sanitizeFilename(entry.name.replace(/\.[^.]+$/, '')),
      ext: path.extname(entry.name).replace(/^\./, ''),
      size,
      mtime,
      tags
    })
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'th'))
  return files
}

// เปลี่ยนชื่อทีละไฟล์ (1 ชื่อใหม่ ต่อ 1 ไฟล์เดิม) — แบบ 2 phase:
//   1) ทุกไฟล์ย้ายไปชื่อชั่วคราวก่อน ปลดล็อกชื่อเดิมที่อาจทับกัน
//   2) แล้วค่อยตั้งเป็นชื่อสุดท้าย (ถ้าชนซ้ำเติม (2), (3)... ท้ายชื่อ)
// คืน { renamed, skipped, errors: [{ id, error }] }
function applyRenames(pattern, ids) {
  const result = { renamed: 0, skipped: 0, errors: [] }
  const list = Array.isArray(ids) ? ids : []
  if (list.length > 1000) list.length = 1000

  const plans = []
  for (const id of list) {
    const full = fileIdDecode(id)
    if (!full || !fs.existsSync(full)) { result.skipped++; continue }
    let stat
    try { stat = fs.statSync(full) } catch (err) { result.skipped++; continue }
    if (!stat.isFile()) { result.skipped++; continue }
    const ext = path.extname(full).replace(/^\./, '')
    const base = path.basename(full).replace(/\.[^.]+$/, '')
    const tags = RenameCore.parseId3Tags(readTagBytes(full))
    const expansion = RenameCore.expandPattern(pattern, tags, plans.length, {
      ext,
      origBase: base,
      maxCount: list.length
    })
    plans.push({ id, from: full, tmp: full + '.awoken-tmp', toName: expansion.name, usedFallback: expansion.usedFallback })
  }

  // phase 1: เปลี่ยนเป็นชื่อชั่วคราวทั้งหมดก่อน (กันชื่อเดิม/ชื่อใหม่ทับกัน)
  const survivors = []
  for (const plan of plans) {
    try {
      fs.renameSync(plan.from, plan.tmp)
      survivors.push(plan)
    } catch (err) {
      result.errors.push({ id: plan.id, error: err.message })
    }
  }

  // phase 2: ตั้งชื่อสุดท้าย ถ้าชนซ้ำให้เติม (2), (3)… ท้ายชื่อ
  const used = new Set()
  for (const plan of survivors) {
    const ext = path.extname(plan.toName)
    const stem = plan.toName.slice(0, plan.toName.length - ext.length)
    let candidate = plan.toName
    let n = 2
    while (used.has(candidate.toLowerCase()) || fs.existsSync(path.join(downloadDir, candidate))) {
      candidate = stem + ' (' + n + ')' + ext
      n++
    }
    used.add(candidate.toLowerCase())
    const to = path.join(downloadDir, candidate)
    try {
      fs.renameSync(plan.tmp, to)
      result.renamed++
    } catch (err) {
      // เปลี่ยนไม่ได้ พยายามคืนชื่อเดิมกลับมา
      try { fs.renameSync(plan.tmp, plan.from) } catch (e) { /* ทิ้งไว้เป็นชื่อชั่วคราว */ }
      result.errors.push({ id: plan.id, error: err.message })
    }
  }
  return result
}

// ----------------------------------------------------------
// HTTP server: API + static (web/)
// ----------------------------------------------------------
const webDir = path.join(rootDir, 'web')
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) reject(new Error('body ใหญ่เกินไป'))
    })
    req.on('end', () => {
      if (!body) return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch (err) {
        reject(new Error('JSON ไม่ถูกต้อง'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ytDlp: ytDlpVersion,
      ytDlpBin,
      ffmpeg: ffmpegOk,
      downloadDir,
      maxConcurrent: Math.max(1, config.maxConcurrent | 0),
      active: activeCount,
      queued: queue.length
    })
  }
  if (pathname === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      active: activeCount,
      queued: queue.length,
      jobs: [...jobs.values()].map(serializeJob)
    })
  }
  if (pathname === '/api/download' && req.method === 'POST') {
    const body = await readBody(req)
    const result = addLinks(body.links)
    return sendJson(res, 200, result)
  }
  if (pathname === '/api/cancel' && req.method === 'POST') {
    const body = await readBody(req)
    const job = jobs.get(String(body.id || ''))
    if (!job) return sendJson(res, 404, { error: 'ไม่พบรายการ' })
    cancelJob(job)
    return sendJson(res, 200, { ok: true })
  }
  if (pathname === '/api/cancel-all' && req.method === 'POST') {
    cancelAll()
    return sendJson(res, 200, { ok: true })
  }
  if (pathname === '/api/clear' && req.method === 'POST') {
    return sendJson(res, 200, { removed: clearFinished() })
  }
  if (pathname === '/api/reveal' && req.method === 'POST') {
    const body = await readBody(req)
    reveal(jobs.get(String(body.id || '')))
    return sendJson(res, 200, { ok: true })
  }
  if (pathname === '/api/open-folder' && req.method === 'POST') {
    reveal(null)
    return sendJson(res, 200, { ok: true })
  }
  if (pathname === '/api/files' && req.method === 'GET') {
    return sendJson(res, 200, { dir: downloadDir, files: listAudioFiles() })
  }
  if (pathname === '/api/rename' && req.method === 'POST') {
    const body = await readBody(req)
    if (typeof body.pattern !== 'string' || !body.pattern.trim()) {
      return sendJson(res, 400, { error: 'ต้องระบุ pattern ชื่อไฟล์' })
    }
    if (!Array.isArray(body.files) || !body.files.length) {
      return sendJson(res, 400, { error: 'เลือกไฟล์อย่างน้อย 1 ไฟล์' })
    }
    const result = applyRenames(body.pattern.trim(), body.files)
    return sendJson(res, 200, result)
  }
  return sendJson(res, 404, { error: 'not found' })
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? '/index.html' : pathname
  const file = path.normalize(path.join(webDir, relative))
  if (!file.startsWith(webDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('Forbidden')
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('404 Not Found')
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream' })
    res.end(data)
  })
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  let pathname
  try {
    pathname = new URL(req.url, 'http://localhost').pathname
  } catch (err) {
    res.writeHead(400)
    return res.end('Bad Request')
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => {
      sendJson(res, 500, { error: err.message })
    })
    return
  }
  serveStatic(res, pathname)
})

probeYtDlp().then((version) => {
  if (!version) {
    console.warn('[yt-dlp] หาไม่เจอหรือรันไม่ได้ ที่ตำแหน่ง:', ytDlpBin)
    console.warn('         ติดตั้งก่อนใช้งาน (ดู README.md) หรือแก้ config.ytDlpPath')
  } else {
    console.log('[yt-dlp] พร้อมใช้งาน เวอร์ชัน:', version)
  }
  probeFfmpeg()
})

server.listen(config.port, config.host, () => {
  console.log('==========================================================')
  console.log('  AwokenYT server กำลังทำงาน')
  console.log('  หน้าเว็บ (serve):  http://' + config.host + ':' + config.port + '/')
  console.log('  โฟลเดอร์ปลายทาง:  ' + downloadDir)
  console.log('  โหลดพร้อมกันสูงสุด: ' + config.maxConcurrent + ' ลิ้ง')
  console.log('  ปิดโปรแกรม: กด Ctrl+C')
  console.log('==========================================================')
})
