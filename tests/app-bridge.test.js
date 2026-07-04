const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildOAuthAccessTokenUrl,
  buildUserInfoUrl,
  chooseRedeem,
  deriveEntitlement,
  extractUnionid,
  getEventValue,
  parseBody,
  signBridgeToken,
  verifyBridgeToken
} = require('../cloudfunctions/appBridge/helpers.js')

test('builds encoded wechat oauth urls without leaking raw values', () => {
  const url = buildOAuthAccessTokenUrl(' wx123 ', 'se+cret', 'co de')
  assert.match(url, /^https:\/\/api\.weixin\.qq\.com\/sns\/oauth2\/access_token\?/)
  assert.match(url, /appid=wx123/)
  assert.match(url, /secret=se%2Bcret/)
  assert.match(url, /code=co\+de/)
  assert.match(url, /grant_type=authorization_code/)
  assert.match(buildUserInfoUrl('tok', 'oid'), /sns\/userinfo\?access_token=tok&openid=oid/)
})

test('extracts unionid from oauth or userinfo responses', () => {
  assert.equal(extractUnionid({ unionid: 'u-1' }), 'u-1')
  assert.equal(extractUnionid({ access_token: 't', openid: 'o' }), '')
  assert.equal(extractUnionid(null), '')
})

test('bridge token roundtrip verifies and rejects tamper/expiry/wrong secret', () => {
  const now = 1000000
  const token = signBridgeToken({ unionid: 'u-abc', expMs: now + 5000, secret: 's1' })

  const ok = verifyBridgeToken(token, 's1', now)
  assert.equal(ok.ok, true)
  assert.equal(ok.unionid, 'u-abc')

  assert.equal(verifyBridgeToken(token, 's2', now).code, 'BAD_TOKEN')
  assert.equal(verifyBridgeToken(token, 's1', now + 6000).code, 'TOKEN_EXPIRED')
  assert.equal(verifyBridgeToken(token + 'x', 's1', now).code, 'BAD_TOKEN')
  assert.equal(verifyBridgeToken('v1.only.three', 's1', now).code, 'BAD_TOKEN')
  assert.equal(verifyBridgeToken('', 's1', now).code, 'BAD_TOKEN')
})

test('redeem decision: member passes free, credit decrements, dedup by key', () => {
  const annual = { annualActive: true, retestCredits: 0 }
  const credit = { annualActive: false, retestCredits: 1 }
  const none = { annualActive: false, retestCredits: 0 }

  assert.deepEqual(chooseRedeem({ ent: annual, redeemKey: 'k1', appRedeems: [] }), { type: 'annual' })
  assert.deepEqual(chooseRedeem({ ent: credit, redeemKey: 'k1', appRedeems: [] }), { type: 'credit' })
  assert.deepEqual(chooseRedeem({ ent: none, redeemKey: 'k1', appRedeems: [] }), { type: 'none' })
  assert.deepEqual(chooseRedeem({ ent: credit, redeemKey: 'k1', appRedeems: ['k1'] }), { type: 'already' })
})

test('derives the same entitlement view as the miniprogram functions', () => {
  const now = 1000
  assert.equal(deriveEntitlement({ annualExpireAt: 2000 }, now).status, 'unlimited')
  assert.equal(deriveEntitlement({ remainCount: 1 }, now).status, 'single')
  assert.equal(deriveEntitlement({ totalSinglePurchased: 1 }, now).status, 'single_used')
  assert.equal(deriveEntitlement(null, now).status, 'none')
  assert.equal(deriveEntitlement({ retestCredits: 2 }, now).retestCredits, 2)
})

test('reads action fields from direct event, http body, or query', () => {
  assert.equal(getEventValue({ action: 'login' }, 'action', ''), 'login')
  assert.equal(getEventValue({ body: JSON.stringify({ action: 'entitlement' }) }, 'action', ''), 'entitlement')
  assert.equal(getEventValue({ queryStringParameters: { action: 'redeemRetest' } }, 'action', ''), 'redeemRetest')
  assert.equal(getEventValue({}, 'action', 'fallback'), 'fallback')
  assert.deepEqual(parseBody('not-json'), {})
})
