// ==========================================================
// ไฟล์: web/app.js
// คำอธิบาย: logic หน้าเว็บ AwokenYT (Vue 3 CDN) — จัดการ textarea
//   วางลิ้งหลายลิ้ง, ส่งเข้าคิวที่ server, poll สถานะ, ควบคุมคิว
//   (ยกเลิก/ล้างรายการ), toast แจ้งเตือน, และ DEV_MODE สำหรับทดสอบ
//   UI ในเบราว์เซอร์โดยไม่ต้องเปิด server
// ==========================================================

const DEV_MODE = false

const API_BASE = DEV_MODE ? '' : 'http://127.0.0.1:5577'
const POLL_MS = 700

const { createApp } = Vue

createApp({
  data() {
    return {
      input: '',
      starting: false,
      connected: false,
      health: {},
      jobs: [],
      toasts: [],
      toastSeq: 0,
      pollTimer: null,
      healthTimer: null
    }
  },

  computed: {
    links() {
      const seen = new Set()
      const found = []
      const regex = /https?:\/\/[^\s"'<>]+/gi
      let match
      while ((match = regex.exec(this.input)) !== null) {
        const url = match[0].replace(/[)\].,]+$/, '')
        if (!seen.has(url)) {
          seen.add(url)
          found.push(url)
        }
      }
      return found
    },

    busyCount() {
      return this.jobs.filter((j) => j.status === 'queued' || j.status === 'downloading' || j.status === 'converting').length
    },

    finishedCount() {
      return this.jobs.filter((j) => j.status === 'done' || j.status === 'error' || j.status === 'canceled').length
    },

    ytDlpReady() {
      return Boolean(this.health.ytDlp)
    }
  },

  methods: {
    // ---------- ยูทิลิตี้ fetch (รวมจัดการ DEV_MODE + error) ----------
    async api(path, options = {}) {
      if (DEV_MODE) {
        console.log('[DEV] api:', path, options.body || '')
        return this.mockResponse(path, options)
      }
      const res = await fetch(API_BASE + path, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'HTTP ' + res.status)
      }
      return res.json()
    },

    mockResponse(path, options) {
      if (path === '/api/health') {
        return Promise.resolve({ ytDlp: 'DEV.MOCK', ffmpeg: true, downloadDir: 'C:\\Mock\\downloads', maxConcurrent: 3, active: 1, queued: 2 })
      }
      if (path === '/api/download') {
        const body = JSON.parse(options.body || '{}')
        return Promise.resolve({ added: (body.links || []).length, skipped: 0 })
      }
      return Promise.resolve({ ok: true, removed: 0 })
    },

    toast(msg, type = 'success') {
      const id = ++this.toastSeq
      this.toasts.push({ id, msg, type })
      setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id)
      }, 3200)
    },

    // ---------- โหลดสถานะ ----------
    async refreshHealth() {
      try {
        this.health = await this.api('/api/health')
        this.connected = true
      } catch (err) {
        this.connected = false
      }
    },

    async refreshStatus() {
      try {
        const data = await this.api('/api/status')
        this.jobs = data.jobs || []
        this.connected = true
      } catch (err) {
        this.connected = false
      }
    },

    // ---------- คำสั่ง ----------
    async startAll() {
      if (!this.links.length) return
      this.starting = true
      try {
        const result = await this.api('/api/download', { method: 'POST', body: { links: this.links } })
        if (result.added > 0) {
          this.toast('เพิ่ม ' + result.added + ' ลิ้งเข้าคิวแล้ว' + (result.skipped ? ' (ข้ามซ้ำ ' + result.skipped + ')' : ''))
          this.input = ''
        } else {
          this.toast('ไม่มีลิ้งใหม่ — ทุกลิ้งอยู่ในคิวอยู่แล้ว', 'error')
        }
        await this.refreshStatus()
      } catch (err) {
        this.toast(err.message, 'error')
      } finally {
        this.starting = false
      }
    },

    async cancel(id) {
      try {
        await this.api('/api/cancel', { method: 'POST', body: { id } })
        await this.refreshStatus()
      } catch (err) {
        this.toast(err.message, 'error')
      }
    },

    async cancelAll() {
      try {
        await this.api('/api/cancel-all', { method: 'POST' })
        this.toast('ยกเลิกทุกรายการแล้ว')
        await this.refreshStatus()
      } catch (err) {
        this.toast(err.message, 'error')
      }
    },

    async clearFinished() {
      try {
        const result = await this.api('/api/clear', { method: 'POST' })
        if (result.removed > 0) this.toast('ล้าง ' + result.removed + ' รายการ')
        await this.refreshStatus()
      } catch (err) {
        this.toast(err.message, 'error')
      }
    },

    async openFolder() {
      try {
        await this.api('/api/open-folder', { method: 'POST' })
      } catch (err) {
        this.toast(err.message, 'error')
      }
    },

    async reveal(id) {
      try {
        await this.api('/api/reveal', { method: 'POST', body: { id } })
      } catch (err) {
        this.toast(err.message, 'error')
      }
    },

    clearInput() {
      this.input = ''
    },

    // ---------- ตัวช่วยแสดงผล ----------
    isTerminal(job) {
      return job.status === 'done' || job.status === 'error' || job.status === 'canceled'
    },

    showProgress(job) {
      return job.status === 'downloading' || job.status === 'converting'
    },

    fileName(job) {
      if (!job.file) return job.title || ''
      return job.file.split(/[\\/]/).pop()
    },

    statusIcon(job) {
      switch (job.status) {
        case 'queued': return 'mdi:clock-outline'
        case 'downloading': return 'mdi:progress-download'
        case 'converting': return 'mdi:loading'
        case 'done': return 'mdi:check-circle'
        case 'error': return 'mdi:alert-circle'
        case 'canceled': return 'mdi:cancel'
        default: return 'mdi:help-circle'
      }
    },

    statusClass(job) {
      switch (job.status) {
        case 'downloading': return 'badge-accent'
        case 'converting': return 'badge-accent'
        case 'done': return 'badge-green'
        case 'error': return 'badge-danger'
        default: return ''
      }
    },

    statusText(job) {
      switch (job.status) {
        case 'queued': return 'คิว'
        case 'downloading': return 'กำลังโหลด'
        case 'converting': return 'แปลงไฟล์'
        case 'done': return 'เสร็จ'
        case 'error': return 'ผิดพลาด'
        case 'canceled': return 'ยกเลิก'
        default: return job.status
      }
    }
  },

  async mounted() {
    if (DEV_MODE) {
      // ข้อมูล mock ให้เห็น UI ทันทีตอนเปิดไฟล์ใน browser โดยไม่ต้องเปิด server
      this.connected = true
      this.health = { ytDlp: 'DEV.MOCK', ffmpeg: true, downloadDir: 'C:\\Mock\\downloads', maxConcurrent: 3 }
      this.jobs = [
        { id: '1', url: 'https://youtu.be/mock1', status: 'done', title: 'Mock Song One [mock1]', percent: 100, speed: '', eta: '', size: '', file: 'C:\\Mock\\downloads\\Mock Song One [mock1].mp3', error: '' },
        { id: '2', url: 'https://youtu.be/mock2', status: 'downloading', title: 'Mock Song Two [mock2]', percent: 42.5, speed: '2.35MiB/s', eta: '00:12', size: '4.20MiB', file: '', error: '' },
        { id: '3', url: 'https://youtu.be/mock3', status: 'queued', title: '', percent: 0, speed: '', eta: '', size: '', file: '', error: '' },
        { id: '4', url: 'https://youtu.be/mock4', status: 'error', title: 'Mock Song Four [mock4]', percent: 12, speed: '', eta: '', size: '', file: '', error: 'Video unavailable' },
        { id: '5', url: 'https://youtu.be/mock5', status: 'converting', title: 'Mock Song Five [mock5]', percent: 100, speed: '', eta: '', size: '', file: '', error: '' }
      ]
      this.input = 'https://www.youtube.com/watch?v=mock6\nhttps://youtu.be/mock7'
    } else {
      this.pollTimer = setInterval(this.refreshStatus, POLL_MS)
      this.healthTimer = setInterval(this.refreshHealth, 5000)
    }
    await this.refreshHealth()
    await this.refreshStatus()
  },

  beforeUnmount() {
    clearInterval(this.pollTimer)
    clearInterval(this.healthTimer)
  }
}).mount('#app')
