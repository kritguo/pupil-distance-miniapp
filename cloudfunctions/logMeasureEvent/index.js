const cloud = require('wx-server-sdk')
const { normalizeMeasureEvent } = require('./helpers.js')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

async function ensureCollection(db, name) {
  if (!db || typeof db.createCollection !== 'function') return
  await db.createCollection(name).catch((err) => {
    const raw = String((err && (err.errMsg || err.message)) || err || '')
    if (!/exist|already/i.test(raw)) throw err
  })
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const now = Date.now()

  let doc
  try {
    doc = normalizeMeasureEvent({ event, openid, now })
  } catch (err) {
    return { ok: false, code: err.code || 'BAD_EVENT', message: err.message || '' }
  }

  const db = cloud.database()
  try {
    await ensureCollection(db, 'measureEvents')
    const existed = await db
      .collection('measureEvents')
      .where({ openid, sessionId: doc.sessionId })
      .limit(1)
      .get()

    if (existed && existed.data && existed.data.length) {
      return { ok: true, duplicate: true, sessionId: doc.sessionId }
    }

    await db.collection('measureEvents').add({
      data: {
        ...doc,
        createTime: db.serverDate(),
        updateTime: db.serverDate()
      }
    })
    return { ok: true, duplicate: false, sessionId: doc.sessionId }
  } catch (err) {
    console.error('[logMeasureEvent] write failed:', err)
    return { ok: false, code: 'DB_FAIL', message: '' + err }
  }
}
