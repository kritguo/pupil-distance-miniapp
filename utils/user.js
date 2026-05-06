// 用户状态管理模块

const USER_KEY = 'pd_user_info'

// 用户状态类型
// none: 未付费
// single: 单次（剩余次数 > 0）
// single_used: 单次已用完
// unlimited: 无限次

// 获取用户信息
function getUserInfo() {
  const info = wx.getStorageSync(USER_KEY)
  return info || {
    status: 'none',      // none | single | single_used | unlimited
    remainCount: 0,      // 剩余测量次数（单次用户用）
    records: [],         // 测量记录（无限用户用）
    lastUnlockedResultTs: null, // 单次用户已解锁的结果时间戳
    singleBatch: { id: null, results: [] }, // 单次测量包（3次）
    unlimitedSession: { id: null, results: [] }, // 无限次测量会话
    trialBatch: { id: null, results: [] }, // 试测缓存（未付费）
    createTime: null,    // 首次激活时间
    updateTime: null     // 最近更新时间
  }
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

// 检查是否可以免费测量（无限用户或有剩余次数）
function canMeasureFree() {
  const info = getUserInfo()
  if (info.status === 'unlimited') return true
  if (info.status === 'single' && info.remainCount > 0) return true
  return false
}

// 检查是否是无限用户
function isUnlimited() {
  const info = getUserInfo()
  return info.status === 'unlimited'
}

// 检查是否需要显示付费提示（首次用户）
function shouldShowPayTip() {
  const info = getUserInfo()
  // 无限用户不显示
  if (info.status === 'unlimited') return false
  // 有剩余次数不显示
  if (info.status === 'single' && info.remainCount > 0) return false
  return true
}

// 激活单次
function activateSingle() {
  const info = getUserInfo()
  info.status = 'single'
  info.remainCount = 3
  info.singleBatch = { id: Date.now().toString(), results: [] }
  if (!info.createTime) info.createTime = Date.now()
  saveUserInfo(info)
}

// 激活无限
function activateUnlimited() {
  const info = getUserInfo()
  info.status = 'unlimited'
  info.remainCount = -1 // 无限
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

// 添加测量记录（仅无限用户）
function addRecord(record) {
  const info = getUserInfo()
  if (info.status === 'unlimited') {
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
}

// 获取测量记录
function getRecords() {
  const info = getUserInfo()
  return info.records || []
}

// 单次升级到无限（补差价）
function upgradeToUnlimited() {
  const info = getUserInfo()
  info.status = 'unlimited'
  info.remainCount = -1
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

// 获取用户状态文本
function getStatusText() {
  const info = getUserInfo()
  switch (info.status) {
    case 'unlimited':
      return '无限次测量'
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
  canMeasureFree,
  isUnlimited,
  shouldShowPayTip,
  activateSingle,
  activateUnlimited,
  useMeasureCount,
  addRecord,
  getRecords,
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
