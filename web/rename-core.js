/* ==========================================================
   ไฟล์: web/rename-core.js
   คำอธิบาย: โมดูลกลางสำหรับจัดชื่อไฟล์เพลง — แปลง pattern → ชื่อไฟล์
     ใช้ร่วมกันทั้งหน้าเว็บ (preview สดๆ), server (rename จริง)
     และไฟล์ test (รันด้วย `node test/rename.test.js`)
   ตัวแปรใน pattern:
     %n = เลขลำดับตามรายการที่เลือก (เติม 0 นำหน้าอัตโนมัติ)
     %t = ชื่อเพลง (จาก tag ID3, ถ้าไม่มีใช้ชื่อไฟล์เดิม)
     %a = ศิลปิน      %b = อัลบั้ม      %y = ปี
     %k = เลข track ในอัลบั้ม (ถ้าไม่มีใช้เลขลำดับเดียวกับ %n)
     %% = ตัวอักษร %
   ตัวอย่าง: pattern "%n. %t" → "01. My Song.mp3"
   ========================================================== */

'use strict'

// ----------------------------------------------------------
// sanitizeFilename: ตัดอักขระต้องห้ามของชื่อไฟล์ Windows ออก
// ----------------------------------------------------------
function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '-') // อักขระต้องห้าม → เครื่องหมายขีด
    .replace(/\s+/g, ' ')          // ยุบช่องว่างซ้ำ
    .trim()
    .replace(/^\.+/, '')           // ไม่ให้ขึ้นด้วยจุด (กัน relative path)
    .replace(/[. ]+$/, '')         // Windows ไม่ชอบชื่อลงท้ายด้วยจุด/ช่องว่าง
    .trim()
}

// ----------------------------------------------------------
// padNumber: 1 → "01" (ตามจำนวนหลักของเลขสูงสุด, ขั้นต่ำ 2 หลัก)
// ----------------------------------------------------------
function padNumber(n, maxCount) {
  const m = Math.max(1, maxCount | 0, n | 0)
  const width = Math.max(2, String(m).length)
  return String(n).padStart(width, '0')
}

// ----------------------------------------------------------
// ตัวช่วยอ่านไบต์ (ใช้ได้ทั้ง Buffer ของ node และ Uint8Array ของ browser)
// ----------------------------------------------------------
function latin1(b, start, end) {
  let s = ''
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i])
  return s
}

function readUInt32(b, off) {
  return ((b[off] * 256 + b[off + 1]) * 256 + b[off + 2]) * 256 + b[off + 3]
}

// syncsafe int ของ ID3v2.4 (7 บิตต่อไบต์)
function syncSafe(b, off) {
  return ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f)
}

// ล้างข้อความจาก tag: ตัด \0 ท้าย/กลาง และช่องว่าง
function cleanText(s) {
  return String(s || '').replace(/\0/g, ' ').replace(/\s+/g, ' ').trim()
}

// ถอดรหัส text frame ตาม encoding byte ตัวแรกของ frame
//   0 = latin1, 1 = utf-16 (มี BOM), 2 = utf-16be, 3 = utf-8
function decodeTextFrame(data) {
  if (!data || data.length < 1) return ''
  const body = data.subarray(1)
  const enc = data[0]
  try {
    if (!body.length) return ''
    if (enc === 1 || enc === 2) {
      // utf-16 พร้อม BOM หรือ big-endian
      let slice = body
      let engine = 'utf-16be'
      if (enc === 1 && body.length >= 2) {
        if (body[0] === 0xff && body[1] === 0xfe) { slice = body.subarray(2); engine = 'utf-16le' }
        else if (body[0] === 0xfe && body[1] === 0xff) { slice = body.subarray(2) }
        else { engine = 'utf-16le' } // ไม่มี BOM — เดาว่าเป็น little-endian
      }
      return cleanText(new TextDecoder(engine).decode(slice))
    }
    if (enc === 3) return cleanText(new TextDecoder('utf-8').decode(body))
    return cleanText(latin1(body, 0, body.length))
  } catch (err) {
    return cleanText(latin1(body, 0, body.length))
  }
}

// ----------------------------------------------------------
// parseId3Tags(buf): อ่าน tag ID3v2.3/2.4 (หัวไฟล์) + ID3v1 (ท้ายไฟล์)
//   คืน { title, artist, album, year, track } — ช่องไหนไม่มีให้คืนค่าว่าง
//   buf: Buffer (node) หรือ Uint8Array (browser)
// ----------------------------------------------------------
function parseId3Tags(buf) {
  const tags = { title: '', artist: '', album: '', year: '', track: '' }
  if (!buf || buf.length < 10) return tags

  // ---------- ID3v2 (อยู่หัวไฟล์: "ID3") ----------
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    try {
      const ver = buf[3] // 3 (v2.3) หรือ 4 (v2.4)
      const flags = buf[5]
      const size = syncSafe(buf, 6)
      const body = buf.subarray(10, Math.min(buf.length, 10 + size))
      let pos = 0
      if (flags & 0x40) { // extended header — ข้ามไป
        pos = ver === 4 ? syncSafe(body, 0) : 4 + readUInt32(body, 0)
      }
      while (pos + 10 <= body.length) {
        const id = latin1(body, pos, pos + 4)
        if (!/^[A-Z0-9]{4}$/.test(id)) break
        const fsize = ver === 4 ? syncSafe(body, pos + 4) : readUInt32(body, pos + 4)
        if (fsize <= 0 || pos + 10 + fsize > body.length) break
        const frame = body.subarray(pos + 10, pos + 10 + fsize)
        const value = id[0] === 'T' ? decodeTextFrame(frame) : cleanText()
        if (value) {
          if (id === 'TIT2' && !tags.title) tags.title = value
          else if (id === 'TPE1' && !tags.artist) tags.artist = value
          else if (id === 'TALB' && !tags.album) tags.album = value
          else if ((id === 'TDRC' || id === 'TYER' || id === 'TDAT') && !tags.year) {
            const m = String(value).match(/\d{2,4}/)
            if (m) tags.year = m[0]
          } else if (id === 'TRCK' && !tags.track) {
            tags.track = String(value).split('/')[0].trim() // เช่น "3/12" → "3"
          }
        }
        pos += 10 + fsize
      }
    } catch (err) { /* แท็กพัง — เดินหน้าไปใช้ ID3v1 ต่อ */ }
  }

  // ---------- ID3v1 (128 ไบต์สุดท้าย: "TAG") ----------
  if (buf.length >= 128) {
    try {
      const tail = buf.subarray(buf.length - 128)
      if (tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) {
        if (!tags.title) tags.title = cleanText(latin1(tail, 3, 33))
        if (!tags.artist) tags.artist = cleanText(latin1(tail, 33, 63))
        if (!tags.album) tags.album = cleanText(latin1(tail, 63, 93))
        if (!tags.year) {
          const y = cleanText(latin1(tail, 93, 97))
          if (/^\d{2,4}$/.test(y)) tags.year = y
        }
        // v1.1: 28 ไบต์ comment ว่าง + ไบต์สุดท้าย = track number
        if (!tags.track && tail[93] === 0 && tail[94] === 0 && tail[97] === 0 && tail[98] === 0 && tail[99] === 0 && tail[125] === 0 && tail[126] === 0 && tail[127] > 0) {
          tags.track = String(tail[127])
        }
      }
    } catch (err) { /* ผ่าน */ }
  }

  return tags
}

// ----------------------------------------------------------
// expandPattern(pattern, tags, index, opts)
//   pattern : เช่น "%n. %t"
//   tags    : { title, artist, album, year, track } ของไฟล์นั้น
//   index   : ลำดับ (0-based) ของไฟล์ในรายการที่เลือก
//   opts    : { ext: 'mp3', origBase: 'ชื่อไฟล์เดิมไม่มีนามสกุล', maxCount: จำนวนไฟล์ที่เลือก }
//   คืน { name: 'ชื่อไฟล์เต็ม.นามสกุล', usedFallback: true ถ้าช่องไหน tag ไม่พอ
//         อ่านไม่ได้ ใช้ชื่อไฟล์เดิมแทน }
// ----------------------------------------------------------
function expandPattern(pattern, tags, index, opts) {
  opts = opts || {}
  const ext = String(opts.ext || 'mp3').replace(/^\.+/, '')
  const origBase = sanitizeFilename(opts.origBase)
  const fallbackBase = origBase || 'track'
  let usedFallback = false

  const val = (key) => {
    const s = sanitizeFilename(tags[key])
    if (s) return s
    if (key !== 'title' && origBase) { /* ใช้ชื่อไฟล์เดิม */ }
    usedFallback = true
    return fallbackBase
  }

  const map = {
    'n': () => padNumber(index + 1, opts.maxCount),
    't': () => val('title'),
    'a': () => val('artist'),
    'b': () => val('album'),
    'y': () => val('year'),
    'k': () => {
      const s = sanitizeFilename(tags.track)
      if (s) return s
      return padNumber(index + 1, opts.maxCount) // ไม่มี track → ใช้ลำดับรายการแทน
    },
    '%': () => '%'
  }

  const src = String(pattern == null || pattern === '' ? '%n. %t' : pattern)
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '%' && i + 1 < src.length && map[src[i + 1]]) {
      out += map[src[i + 1]]()
      i += 2
    } else {
      out += ch
      i++
    }
  }

  return { name: sanitizeFilename(out) + '.' + ext, usedFallback }
}

// ----------------------------------------------------------
// exports: browser → window.RenameCore, node → module.exports
// ----------------------------------------------------------
const RenameCore = { sanitizeFilename, padNumber, parseId3Tags, expandPattern }
if (typeof module !== 'undefined' && module.exports) module.exports = RenameCore
if (typeof window !== 'undefined') window.RenameCore = RenameCore
