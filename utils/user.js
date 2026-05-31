// 用户状态管理模块
//
// 权益（status / remainCount / annualExpireAt）以服务端为准：
//   - 由 utils/pay.js 调用云函数 getEntitlement / consumeMeasure / 支付成功后，
//     再通过 applyServerEntitlement() 写入本地缓存。
//   - 本地缓存只作为离线兜底与 UI 状态，真值在服务端 users 集合。
// 本地仍保存的 UI 状态：试测缓存、单次三次包、无限会话、历史记录。

const config = require('../config.js')

const USER_KEY = 'pd_user_info'

const isNumber = (value) => typeof value === 'number' && !Number.isNaN(value)

// 测试开关：开启后本地一律按年度会员处理，绕过付费墙（上线前在 config.dev.bypassPay 关掉）
const isDevBypass = () => !!(config.dev && config.dev.bypassPay)

// 用户状态类型
// none: 未付费
// single: 单次（剩余次数 > 0）
// single_used: 单次已用完
// unlimited: 年度会员有效期内（一年不限次数）

// 获取用户信息
function getUserInfo() {
  const info = wx.getStorageSync(USER_KEY)
  return info || {
    status: 'none',      // none | single | single_used | unlimited
    remainCount: 0,      // 剩余测量次数（单次用户用）
    annualExpireAt: 0,   // 年度会员到期时间戳(ms)，0 表示非年度会员
    records: [],         // 测量记录（年度会员用）
    lastUnlockedResultTs: null, // 单次用户已解锁的结果时间戳（本地去重，避免重复扣次）
    singleBatch: { id: null, results: [] }, // 一次测量的 3 张照片（取中位数）
    unlimitedSession: { id: null, results: [] }, // 年度会员测量会话
    trialBatch: { id: null, results: [] }, // 试测缓存（未付费）
    serverSyncedAt: null, // 最近一次服务端权益同步时间
    createTime: null,    // 首次激活时间
    updateTime: null     // 最近更新时间
  }
}

// 用服务端权益覆盖本地缓存（getEntitlement / consumeMeasure / 支付成功后调用）
function applyServerEntitlement(ent) {
  if (!ent || ent.ok === false) return getUserInfo()
  const info = getUserInfo()
  if (typeof ent.status === 'string') info.status = ent.status
  if (isNumber(ent.remainCount)) info.remainCount = ent.remainCount
  if (isNumber(ent.retestCredits)) info.retestCredits = ent.retestCredits
  if (isNumber(ent.annualExpireAt)) info.annualExpireAt = ent.annualExpireAt
  info.serverSyncedAt = Date.now()
  if (!info.createTime && info.status !== 'none') info.createTime = Date.now()
  saveUserInfo(info)
  return info
}

// 年度会员是否在有效期内（测试开关开启时直接视为会员）
function isAnnualActive(info) {
  if (isDevBypass()) return true
  const data = info || getUserInfo()
  return !!(data.annualExpireAt && data.annualExpireAt > Date.now())
}

// 年度会员到期时间戳
function getAnnualExpireAt() {
  return getUserInfo().annualExpireAt || 0
}

// 年度会员剩余天数（向上取整），非会员返回 0
function getAnnualRemainDays() {
  const expireAt = getAnnualExpireAt()
  if (!expireAt || expireAt <= Date.now()) return 0
  return Math.ceil((expireAt - Date.now()) / (24 * 3600 * 1000))
}

function ensureSingleBatch(info) {
  if (!info.singleBatch || !Array.isArray(info.singleBatch.results)) {
    info.singleBatch = { id: Date.now().toString(), results: [] }
  }
}

function ensureUnlimitedSession(info) {
  if (!info.unlimitedSession || !Array.isArray(info.unlimitedSession.results)) {
    info.unlimitedSession = { id: Date.now().toString(), results: [] }
  }
}

function ensureTrialBatch(info) {
  if (!info.trialBatch || !Array.isArray(info.trialBatch.results)) {
    info.trialBatch = { id: Date.now().toString(), results: [] }
  }
}

// 保存用户信息
function saveUserInfo(info) {
  info.updateTime = Date.now()
  wx.setStorageSync(USER_KEY, info)
}

// 检查是否可以免费测量（年度会员或有剩余次数）
function canMeasureFree() {
  const info = getUserInfo()
  if (isAnnualActive(info)) return true
  if (info.status === 'single' && info.remainCount > 0) return true
  return false
}

// 检查是否是年度会员（有效期内）
function isUnlimited() {
  return isAnnualActive()
}

// 检查是否需要显示付费提示（首次用户）
function shouldShowPayTip() {
  const info = getUserInfo()
  // 年度会员不显示
  if (isAnnualActive(info)) return false
  // 有剩余次数不显示
  if (info.status === 'single' && info.remainCount > 0) return false
  return true
}

// 激活单次（¥9.9 = 一次测量；可信度中/低时另发免费补测，见 grantFreeRetest）
function activateSingle() {
  const info = getUserInfo()
  info.status = 'single'
  info.remainCount = 1
  info.singleBatch = { id: Date.now().toString(), results: [] }
  if (!info.createTime) info.createTime = Date.now()
  saveUserInfo(info)
}

// 激活年度会员（一年不限次数）——本地乐观更新，真值仍以服务端为准
const ANNUAL_MS = 365 * 24 * 3600 * 1000
function activateUnlimited() {
  const info = getUserInfo()
  info.status = 'unlimited'
  info.remainCount = -1 // 不限次
  const base = Math.max(Date.now(), info.annualExpireAt || 0)
  info.annualExpireAt = base + ANNUAL_MS
  info.unlimitedSession = { id: Date.now().toString(), results: [] }
  if (!info.createTime) info.createTime = Date.now()
  saveUserInfo(info)
}

// 使用一次测量机会
function useMeasureCount() {
  const info = getUserInfo()
  if (info.status === 'single' && info.remainCount > 0) {
    info.remainCount -= 1
    if (info.remainCount === 0) {
      info.status = 'single_used'
    }
    saveUserInfo(info)
  }
}

// 添加测量记录（已付费用户：年度会员 / 单次 均保存到个人中心）
function addRecord(record) {
  const info = getUserInfo()
  const paid = isAnnualActive(info) || info.status === 'single' || info.status === 'single_used'
  if (!paid) return
  const recordTime = record.timestamp || Date.now()
  if (info.records.some(item => item.time === recordTime)) {
    return
  }
  record.time = recordTime
  record.id = recordTime.toString()
  info.records.unshift(record) // 新记录在前
  // 最多保存50条
  if (info.records.length > 50) {
    info.records = info.records.slice(0, 50)
  }
  saveUserInfo(info)
}

// 给某条记录设置/更新「测量对象」名字（按时间戳定位）
function updateRecordName(timestamp, name) {
  if (!timestamp) return
  const info = getUserInfo()
  if (!Array.isArray(info.records)) return
  const rec = info.records.find(item => item.time === timestamp)
  if (rec) {
    rec.name = name
    saveUserInfo(info)
  }
}

// 获取测量记录
function getRecords() {
  const info = getUserInfo()
  return info.records || []
}

// 删除一条测量记录（按 id 或 time 定位）
function deleteRecord(id) {
  if (!id && id !== 0) return
  const info = getUserInfo()
  if (!Array.isArray(info.records)) return
  const key = String(id)
  info.records = info.records.filter((r) => String(r.id) !== key && String(r.time) !== key)
  saveUserInfo(info)
}

// 单次升级到年度会员（补差价）——本地乐观更新
function upgradeToUnlimited() {
  const info = getUserInfo()
  info.status = 'unlimited'
  info.remainCount = -1
  const base = Math.max(Date.now(), info.annualExpireAt || 0)
  info.annualExpireAt = base + ANNUAL_MS
  ensureUnlimitedSession(info)
  saveUserInfo(info)
}

// 记录单次用户已解锁的结果
function setLastUnlockedResult(timestamp) {
  const info = getUserInfo()
  info.lastUnlockedResultTs = timestamp
  saveUserInfo(info)
}

function isLastUnlockedResult(timestamp) {
  const info = getUserInfo()
  return !!timestamp && info.lastUnlockedResultTs === timestamp
}

// 单次用户是否可回看最新结果
function canViewLatestResult(timestamp) {
  const info = getUserInfo()
  if (info.status !== 'single_used') return false
  if (!timestamp || !info.lastUnlockedResultTs) return false
  return info.lastUnlockedResultTs === timestamp
}

function getSingleBatchResults() {
  const info = getUserInfo()
  ensureSingleBatch(info)
  return info.singleBatch.results || []
}

function addSingleResult(result) {
  const info = getUserInfo()
  ensureSingleBatch(info)
  if (!result || !result.timestamp) return
  if (info.singleBatch.results.some(item => item.timestamp === result.timestamp)) {
    return
  }
  if (info.singleBatch.results.length >= 3) return
  info.singleBatch.results.push(result)
  saveUserInfo(info)
}

function resetSingleBatch() {
  const info = getUserInfo()
  info.singleBatch = { id: Date.now().toString(), results: [] }
  saveUserInfo(info)
}

function getUnlimitedSessionResults() {
  const info = getUserInfo()
  ensureUnlimitedSession(info)
  return info.unlimitedSession.results || []
}

function addUnlimitedSessionResult(result) {
  const info = getUserInfo()
  ensureUnlimitedSession(info)
  if (!result || !result.timestamp) return
  if (info.unlimitedSession.results.some(item => item.timestamp === result.timestamp)) {
    return
  }
  info.unlimitedSession.results.push(result)
  saveUserInfo(info)
}

function resetUnlimitedSession() {
  const info = getUserInfo()
  info.unlimitedSession = { id: Date.now().toString(), results: [] }
  saveUserInfo(info)
}

function getTrialResults() {
  const info = getUserInfo()
  ensureTrialBatch(info)
  return info.trialBatch.results || []
}

function addTrialResult(result) {
  const info = getUserInfo()
  ensureTrialBatch(info)
  if (!result || !result.timestamp) return
  if (info.trialBatch.results.some(item => item.timestamp === result.timestamp)) {
    return
  }
  if (info.trialBatch.results.length >= 3) return
  info.trialBatch.results.push(result)
  saveUserInfo(info)
}

function resetTrialBatch() {
  const info = getUserInfo()
  info.trialBatch = { id: Date.now().toString(), results: [] }
  saveUserInfo(info)
}

function unlockTrialAsSingle() {
  const info = getUserInfo()
  ensureTrialBatch(info)
  info.status = 'single_used'
  info.remainCount = 0
  info.singleBatch = {
    id: info.trialBatch.id || Date.now().toString(),
    results: info.trialBatch.results.slice(0, 3)
  }
  if (info.singleBatch.results.length > 0) {
    const last = info.singleBatch.results[info.singleBatch.results.length - 1]
    info.lastUnlockedResultTs = last.timestamp || Date.now()
  }
  info.trialBatch = { id: Date.now().toString(), results: [] }
  saveUserInfo(info)
}

// 格式化到期日期为 YYYY-MM-DD
function formatDate(timestamp) {
  if (!timestamp) return ''
  const d = new Date(timestamp)
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// 获取用户状态文本
function getStatusText() {
  const info = getUserInfo()
  if (isAnnualActive(info)) {
    return `年度会员 · 有效期至 ${formatDate(info.annualExpireAt)}`
  }
  switch (info.status) {
    case 'single':
      return `剩余 ${info.remainCount} 次`
    case 'single_used':
      return '已用完'
    default:
      return '未激活'
  }
}

module.exports = {
  getUserInfo,
  saveUserInfo,
  applyServerEntitlement,
  isAnnualActive,
  getAnnualExpireAt,
  getAnnualRemainDays,
  formatDate,
  canMeasureFree,
  isUnlimited,
  shouldShowPayTip,
  activateSingle,
  activateUnlimited,
  useMeasureCount,
  addRecord,
  updateRecordName,
  getRecords,
  deleteRecord,
  upgradeToUnlimited,
  setLastUnlockedResult,
  isLastUnlockedResult,
  canViewLatestResult,
  getSingleBatchResults,
  addSingleResult,
  resetSingleBatch,
  getUnlimitedSessionResults,
  addUnlimitedSessionResult,
  resetUnlimitedSession,
  getTrialResults,
  addTrialResult,
  resetTrialBatch,
  unlockTrialAsSingle,
  getStatusText
}
